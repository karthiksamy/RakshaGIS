import hashlib
import hmac
import os
import uuid

from django.core.cache import cache
from django.utils import timezone
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from .models import Organisation, User, TwoFactorDevice, TwoFactorPendingAuth, UserSession, LoginAuditLog, ExportAuditLog
from .permissions import (
    IsSuperAdmin, CanManageUsers, OrgScopedAccess,
    org_queryset_filter, get_assignable_roles,
)
from .serializers import OrganisationSerializer, UserSerializer, UserProfileSerializer


def _get_client_ip(request):
    x_forwarded = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded:
        return x_forwarded.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR')


def _get_device_name(user_agent: str) -> str:
    ua = user_agent.lower()
    if 'mobile' in ua or 'android' in ua:
        return 'Mobile'
    if 'ipad' in ua or 'tablet' in ua:
        return 'Tablet'
    return 'Desktop'


class OrganisationViewSet(viewsets.ModelViewSet):
    queryset = Organisation.objects.select_related('parent').order_by('level', 'name')
    serializer_class = OrganisationSerializer
    pagination_class = None  # small hierarchy dataset — return all at once

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [IsSuperAdmin()]

    def get_queryset(self):
        from apps.survey_projects.access import hq_level
        user = self.request.user
        qs = super().get_queryset()
        if user.role == User.SUPERADMIN:
            org = getattr(user, 'organisation', None)
            if org is not None and hq_level(user):
                # HQ-attached superadmin: own subtree only (no access to other commands)
                return qs.filter(id__in=org.get_subtree_ids())
            return qs  # Global superadmin sees all orgs
        org = getattr(user, 'organisation', None)
        if org is None:
            return qs.none()
        # Build the full subtree via BFS so any depth (DGDE→PDDE→DEO→CEO→ADEO) is covered.
        # DGDE-level orgs reach all 5 levels; PDDE reaches 3 levels; DEO reaches 2 levels.
        ids = {org.id}
        for _ in range(5):
            children = set(
                Organisation.objects.filter(parent_id__in=ids)
                .values_list('id', flat=True)
            )
            new = children - ids
            if not new:
                break
            ids |= new
        return qs.filter(id__in=ids)


class UserViewSet(viewsets.ModelViewSet):
    serializer_class = UserSerializer

    def get_permissions(self):
        if self.action == 'me':
            return [permissions.IsAuthenticated()]
        if self.action in ['list', 'retrieve']:
            return [CanManageUsers()]
        if self.action in ['update', 'partial_update', 'destroy']:
            return [CanManageUsers(), OrgScopedAccess()]
        return [CanManageUsers()]  # create

    def get_queryset(self):
        from apps.survey_projects.access import hq_level
        user = self.request.user
        qs = User.objects.select_related('organisation').order_by('username')
        if user.role == User.SUPERADMIN:
            org = getattr(user, 'organisation', None)
            if org is not None and hq_level(user):
                # HQ-attached superadmin: manage users in own org only
                return qs.filter(organisation=org)
            return qs  # Global superadmin sees all users
        if user.role in (User.DEO_ADMIN, User.CEO_ADMIN, User.ADEO_ADMIN):
            # Admins see non-admin users within their own org only
            return qs.filter(organisation=user.organisation).exclude(
                role__in=User.ADMIN_ROLES
            )
        return qs.filter(pk=user.pk)

    def perform_create(self, serializer):
        from apps.survey_projects.access import hq_level
        user = self.request.user
        if user.role == User.SUPERADMIN:
            org = getattr(user, 'organisation', None)
            if org is not None and hq_level(user):
                # HQ-attached superadmin: can only create users in own office
                target_org = serializer.validated_data.get('organisation', org)
                if target_org != org:
                    raise PermissionDenied('HQ offices can only create users within their own office.')
                serializer.save(organisation=org)
            else:
                serializer.save()
            return

        if user.role in (User.DEO_ADMIN, User.CEO_ADMIN, User.ADEO_ADMIN):
            allowed = get_assignable_roles(user.role)
            role = serializer.validated_data.get('role', User.SDO)
            if role not in allowed:
                raise PermissionDenied(
                    f"{user.get_role_display()} can only create: "
                    + ", ".join(sorted(allowed))
                )
            serializer.save(organisation=user.organisation)
            return

        raise PermissionDenied("You do not have permission to create users.")

    def destroy(self, request, *args, **kwargs):
        target = self.get_object()
        # Admins (any role) cannot delete their own account
        if target.pk == request.user.pk and request.user.role in User.ADMIN_ROLES:
            raise PermissionDenied('Admins cannot delete their own account.')
        return super().destroy(request, *args, **kwargs)

    def partial_update(self, request, *args, **kwargs):
        target = self.get_object()
        data = request.data
        # Admins cannot deactivate themselves
        if target.pk == request.user.pk and request.user.role in User.ADMIN_ROLES:
            if 'is_active' in data and not data.get('is_active'):
                raise PermissionDenied('Admins cannot deactivate their own account.')
            # Admins cannot demote their own role
            if 'role' in data and data.get('role') != request.user.role:
                raise PermissionDenied('Admins cannot change their own role.')
        return super().partial_update(request, *args, **kwargs)

    @action(detail=True, methods=['post'], url_path='force-logout')
    def force_logout(self, request, pk=None):
        target = self.get_object()
        # Admins cannot force-logout themselves
        if target.pk == request.user.pk and request.user.role in User.ADMIN_ROLES:
            raise PermissionDenied('Admins cannot force-logout their own account.')
        target.is_active = False
        target.save(update_fields=['is_active'])
        return Response({'detail': 'User logged out and deactivated.'})

    @action(detail=True, methods=['post'], url_path='change-password')
    def change_password(self, request, pk=None):
        from django.contrib.auth.hashers import make_password as dj_make_password
        target = self.get_object()
        new_pw_sha512 = request.data.get('new_password_sha512', '').strip().lower()
        if len(new_pw_sha512) != 128:
            return Response({'detail': 'Invalid password hash.'}, status=400)
        target.sha512_password = new_pw_sha512
        target.password = dj_make_password(new_pw_sha512)
        target.save(update_fields=['password', 'sha512_password'])
        return Response({'detail': 'Password changed.'})

    @action(detail=False, methods=['post'], url_path='change-my-password',
            permission_classes=[permissions.IsAuthenticated])
    def change_my_password(self, request):
        from django.contrib.auth.hashers import make_password as dj_make_password
        old_pw_sha512 = request.data.get('old_password_sha512', '').strip().lower()
        new_pw_sha512 = request.data.get('new_password_sha512', '').strip().lower()
        if not hmac.compare_digest(request.user.sha512_password or '', old_pw_sha512):
            return Response({'detail': 'Wrong current password.'}, status=400)
        if len(new_pw_sha512) != 128:
            return Response({'detail': 'Invalid new password hash.'}, status=400)
        request.user.sha512_password = new_pw_sha512
        request.user.password = dj_make_password(new_pw_sha512)
        request.user.save(update_fields=['password', 'sha512_password'])
        return Response({'detail': 'Password changed.'})

    @action(detail=False, methods=['get'], permission_classes=[permissions.IsAuthenticated])
    def me(self, request):
        serializer = UserProfileSerializer(request.user)
        return Response(serializer.data)


# ── Auth Challenge (nonce for challenge-response login) ───────────────────────

_NONCE_TTL = 300  # 5 minutes


class AuthChallengeView(APIView):
    """Return a one-time nonce. Client must call this before login and use the
    nonce to compute SHA-512(SHA-512(password) + nonce) before submitting."""
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        nonce_id = str(uuid.uuid4())
        nonce = os.urandom(32).hex()
        cache.set(f'auth_nonce:{nonce_id}', nonce, timeout=_NONCE_TTL)
        return Response({'nonce_id': nonce_id, 'nonce': nonce})


# ── Custom Login (2FA + session tracking + audit logging) ─────────────────────

class CustomLoginView(APIView):
    """Challenge-response login.

    Normal flow (migrated accounts):
      1. GET /auth/challenge/ → {nonce_id, nonce}
      2. compute password_hash = SHA-512(SHA-512(raw_password) + nonce) [hex]
      3. POST {username, password_hash, nonce_id}

    Transition flow (accounts without sha512_password yet):
      1. GET /auth/challenge/ → {nonce_id, nonce}
      2. POST {username, password_hash, nonce_id}  → {needs_migration: true}
      3. POST {username, password_raw, nonce_id}   → auto-migrates, issues tokens
    """
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        from django.contrib.auth import authenticate as django_authenticate
        from django.contrib.auth.hashers import make_password as dj_make_password

        username = request.data.get('username', '').strip()
        password_hash = request.data.get('password_hash', '').strip().lower()
        password_raw = request.data.get('password_raw', '')   # transition only
        nonce_id = request.data.get('nonce_id', '').strip()
        ip = _get_client_ip(request)
        ua = request.META.get('HTTP_USER_AGENT', '')

        if not username or not nonce_id:
            return Response({'detail': 'Missing credentials.'}, status=status.HTTP_400_BAD_REQUEST)

        # Look up user
        try:
            user = User.objects.get(username=username)
        except User.DoesNotExist:
            LoginAuditLog.objects.create(
                username_attempted=username, success=False,
                ip_address=ip, user_agent=ua[:500], failure_reason='User not found',
            )
            return Response({'detail': 'Invalid credentials.'}, status=status.HTTP_401_UNAUTHORIZED)

        # ── TRANSITION PATH: account not yet migrated to SHA-512 ──────────────
        if not user.sha512_password:
            if not password_raw:
                # First attempt: tell frontend to retry with the raw password.
                # Do NOT consume the nonce yet so the second request can use it.
                return Response({'needs_migration': True}, status=status.HTTP_200_OK)

            # Second attempt: client sent raw password — verify via Django auth
            cache_key = f'auth_nonce:{nonce_id}'
            nonce = cache.get(cache_key)
            if not nonce:
                return Response(
                    {'detail': 'Challenge expired. Please try again.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            cache.delete(cache_key)

            auth_user = django_authenticate(request, username=username, password=password_raw)
            if not auth_user:
                LoginAuditLog.objects.create(
                    user=user, username_attempted=username, success=False,
                    ip_address=ip, user_agent=ua[:500], failure_reason='Wrong password (migration)',
                )
                return Response({'detail': 'Invalid credentials.'}, status=status.HTTP_401_UNAUTHORIZED)

            # Auto-migrate: store sha512_password for all future logins
            sha512_pw = hashlib.sha512(password_raw.encode('utf-8')).hexdigest()
            user.sha512_password = sha512_pw
            user.password = dj_make_password(sha512_pw)
            user.save(update_fields=['password', 'sha512_password'])
            user = auth_user  # use the authenticated user object

        else:
            # ── NORMAL PATH: challenge-response verification ───────────────────
            if not password_hash:
                return Response({'detail': 'Missing password hash.'}, status=status.HTTP_400_BAD_REQUEST)

            cache_key = f'auth_nonce:{nonce_id}'
            nonce = cache.get(cache_key)
            if not nonce:
                return Response(
                    {'detail': 'Challenge expired or invalid. Please refresh and try again.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            cache.delete(cache_key)

            expected = hashlib.sha512(
                (user.sha512_password + nonce).encode('utf-8')
            ).hexdigest()
            if not hmac.compare_digest(expected, password_hash):
                LoginAuditLog.objects.create(
                    user=user, username_attempted=username, success=False,
                    ip_address=ip, user_agent=ua[:500], failure_reason='Wrong password',
                )
                return Response({'detail': 'Invalid credentials.'}, status=status.HTTP_401_UNAUTHORIZED)

        if not user.is_active:
            LoginAuditLog.objects.create(
                user=user, username_attempted=username, success=False,
                ip_address=ip, user_agent=ua[:500], failure_reason='Account disabled',
            )
            return Response({'detail': 'Account is disabled.'}, status=status.HTTP_401_UNAUTHORIZED)

        # ── 2FA is MANDATORY ───────────────────────────────────────────────
        # Tokens are only ever issued after a successful TOTP verification:
        #   enabled device      → requires_2fa       (enter OTP)
        #   no / unconfirmed    → requires_2fa_setup (forced registration)
        pending = TwoFactorPendingAuth.objects.create(user=user)
        try:
            device = user.two_factor
        except TwoFactorDevice.DoesNotExist:
            device = None

        if device and device.is_enabled:
            return Response({
                'requires_2fa': True,
                'pre_auth_key': str(pending.token),
            })

        return Response({
            'requires_2fa_setup': True,
            'pre_auth_key': str(pending.token),
        })


def _resolve_pending_auth(pre_auth_key):
    """Return a valid TwoFactorPendingAuth or None (invalid/expired/garbage)."""
    if not pre_auth_key:
        return None
    try:
        pending = TwoFactorPendingAuth.objects.select_related('user').get(token=pre_auth_key)
    except Exception:   # DoesNotExist or invalid UUID
        return None
    if pending.is_expired():
        pending.delete()
        return None
    return pending


class TwoFactorCompleteView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        import pyotp
        pre_auth_key = request.data.get('pre_auth_key', '')
        totp_code = str(request.data.get('totp_code', '')).strip().replace(' ', '')
        ip = _get_client_ip(request)
        ua = request.META.get('HTTP_USER_AGENT', '')

        pending = _resolve_pending_auth(pre_auth_key)
        if not pending:
            return Response({'detail': 'Login session expired. Please log in again.'}, status=401)

        user = pending.user
        try:
            device = user.two_factor
            # valid_window=2 → ±60 s tolerance for phone/server clock drift
            totp = pyotp.TOTP(device.secret)
            if not totp.verify(totp_code, valid_window=2):
                LoginAuditLog.objects.create(
                    user=user, username_attempted=user.username, success=False,
                    ip_address=ip, user_agent=ua[:500], failure_reason='Invalid 2FA code',
                )
                return Response({'detail': 'Invalid authenticator code.'}, status=400)
        except TwoFactorDevice.DoesNotExist:
            return Response({'detail': 'No 2FA device configured.'}, status=400)

        pending.delete()
        return _issue_tokens(user, ip, ua)


class TwoFactorSetupBeginView(APIView):
    """Pre-auth 2FA enrollment (mandatory 2FA, first login).

    POST {pre_auth_key} → {qr_code, secret}
    Only valid while the device is NOT yet enabled; once enabled the normal
    OTP flow (TwoFactorCompleteView) must be used.
    """
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        import pyotp, qrcode, io, base64
        pending = _resolve_pending_auth(request.data.get('pre_auth_key', ''))
        if not pending:
            return Response({'detail': 'Login session expired. Please log in again.'}, status=401)

        device, _ = TwoFactorDevice.objects.get_or_create(user=pending.user)
        if device.is_enabled:
            return Response({'detail': '2FA already enabled. Use your authenticator code.'}, status=400)
        if not device.secret:
            device.secret = pyotp.random_base32()
            device.save(update_fields=['secret'])

        totp = pyotp.TOTP(device.secret)
        uri = totp.provisioning_uri(name=pending.user.username, issuer_name='RakshaGIS')
        img = qrcode.make(uri)
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        qr_b64 = base64.b64encode(buf.getvalue()).decode()
        return Response({
            'secret': device.secret,
            'qr_code': f'data:image/png;base64,{qr_b64}',
        })


class TwoFactorSetupCompleteView(APIView):
    """Verify the first TOTP code, enable the device and issue tokens.

    POST {pre_auth_key, code} → {access, refresh}
    """
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        import pyotp
        code = str(request.data.get('code', '')).strip().replace(' ', '')
        ip = _get_client_ip(request)
        ua = request.META.get('HTTP_USER_AGENT', '')

        pending = _resolve_pending_auth(request.data.get('pre_auth_key', ''))
        if not pending:
            return Response({'detail': 'Login session expired. Please log in again.'}, status=401)

        user = pending.user
        try:
            device = user.two_factor
        except TwoFactorDevice.DoesNotExist:
            return Response({'detail': 'Scan the QR code first.'}, status=400)
        if not device.secret:
            return Response({'detail': 'Scan the QR code first.'}, status=400)

        totp = pyotp.TOTP(device.secret)
        if not totp.verify(code, valid_window=2):
            LoginAuditLog.objects.create(
                user=user, username_attempted=user.username, success=False,
                ip_address=ip, user_agent=ua[:500], failure_reason='Invalid 2FA code (enrollment)',
            )
            return Response({'detail': 'Invalid code. Check your authenticator app and try again.'}, status=400)

        device.is_enabled = True
        device.confirmed_at = timezone.now()
        device.save(update_fields=['is_enabled', 'confirmed_at'])
        pending.delete()
        return _issue_tokens(user, ip, ua)


class TwoFactorSetupView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        """Return QR code URI and secret for initial setup."""
        import pyotp, qrcode, io, base64
        device, _ = TwoFactorDevice.objects.get_or_create(user=request.user)
        if not device.secret:
            device.secret = pyotp.random_base32()
            device.save(update_fields=['secret'])

        totp = pyotp.TOTP(device.secret)
        uri = totp.provisioning_uri(
            name=request.user.username,
            issuer_name='RakshaGIS'
        )
        img = qrcode.make(uri)
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        qr_b64 = base64.b64encode(buf.getvalue()).decode()
        return Response({
            'secret': device.secret,
            'qr_code': f'data:image/png;base64,{qr_b64}',
            'is_enabled': device.is_enabled,
        })

    def post(self, request):
        """Verify TOTP code and enable 2FA."""
        import pyotp
        code = str(request.data.get('code', '')).strip().replace(' ', '')
        try:
            device = request.user.two_factor
        except TwoFactorDevice.DoesNotExist:
            return Response({'detail': 'Run GET first to generate secret.'}, status=400)

        totp = pyotp.TOTP(device.secret)
        if not totp.verify(code, valid_window=2):
            return Response({'detail': 'Invalid code.'}, status=400)

        device.is_enabled = True
        device.confirmed_at = timezone.now()
        device.save(update_fields=['is_enabled', 'confirmed_at'])
        return Response({'detail': '2FA enabled successfully.'})

    def delete(self, request):
        """Disable 2FA."""
        try:
            device = request.user.two_factor
            device.is_enabled = False
            device.save(update_fields=['is_enabled'])
        except TwoFactorDevice.DoesNotExist:
            pass
        return Response({'detail': '2FA disabled.'})


# ── Session Management ────────────────────────────────────────────────────────

class UserSessionViewSet(viewsets.ReadOnlyModelViewSet):
    permission_classes = [permissions.IsAuthenticated]
    http_method_names = ['get', 'delete', 'head', 'options']

    def get_queryset(self):
        return UserSession.objects.filter(user=self.request.user, is_revoked=False)

    def get_serializer_class(self):
        from .serializers import UserSessionSerializer
        return UserSessionSerializer

    def destroy(self, request, *args, **kwargs):
        session = self.get_object()
        session.is_revoked = True
        session.save(update_fields=['is_revoked'])
        return Response({'detail': 'Session revoked.'}, status=204)

    @action(detail=False, methods=['delete'], url_path='revoke-all')
    def revoke_all(self, request):
        UserSession.objects.filter(user=request.user, is_revoked=False).update(is_revoked=True)
        return Response({'detail': 'All sessions revoked.'})


# ── Audit Log Views ───────────────────────────────────────────────────────────

class LoginAuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    permission_classes = [IsSuperAdmin]

    def get_queryset(self):
        from .serializers import LoginAuditLogSerializer
        qs = LoginAuditLog.objects.select_related('user').order_by('-timestamp')
        success = self.request.query_params.get('success')
        if success is not None:
            qs = qs.filter(success=success.lower() == 'true')
        user_id = self.request.query_params.get('user')
        if user_id:
            qs = qs.filter(user_id=user_id)
        return qs[:500]

    def get_serializer_class(self):
        from .serializers import LoginAuditLogSerializer
        return LoginAuditLogSerializer


class ExportAuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        user = self.request.user
        qs = ExportAuditLog.objects.select_related('user', 'project').order_by('-timestamp')
        if not user.is_superadmin:
            qs = qs.filter(user=user)
        return qs[:500]

    def get_serializer_class(self):
        from .serializers import ExportAuditLogSerializer
        return ExportAuditLogSerializer


def _issue_tokens(user, ip, ua):
    """Create JWT tokens, record UserSession, log successful login."""
    refresh = RefreshToken.for_user(user)
    jti = str(refresh.access_token['jti'])

    UserSession.objects.create(
        user=user, jti=jti,
        ip_address=ip, user_agent=ua[:500],
        device_name=_get_device_name(ua),
    )
    LoginAuditLog.objects.create(
        user=user, username_attempted=user.username,
        success=True, ip_address=ip, user_agent=ua[:500],
    )
    return Response({
        'access': str(refresh.access_token),
        'refresh': str(refresh),
        'requires_2fa': False,
    })
