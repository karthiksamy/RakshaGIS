import hashlib
import uuid

from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone


class Organisation(models.Model):
    DGDE = 'DGDE'
    PDDE = 'PDDE'
    DEO  = 'DEO'
    CEO  = 'CEO'
    ADEO = 'ADEO'

    LEVEL_CHOICES = [
        (DGDE, 'DGDE (National)'),
        (PDDE, 'PDDE (Command)'),
        (DEO,  'DEO (District/Area)'),
        (CEO,  'CEO (Cantonment)'),
        (ADEO, 'ADEO (Sub-Area)'),
    ]

    name = models.CharField(max_length=200)
    code = models.CharField(max_length=20, unique=True)
    level = models.CharField(max_length=10, choices=LEVEL_CHOICES)
    parent = models.ForeignKey(
        'self', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='subordinates'
    )
    address = models.TextField(blank=True)
    default_basemap = models.ForeignKey(
        'core.BasemapConfig', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='org_defaults',
        help_text='Basemap shown by default to users in this org'
    )

    # ── mst_office mirror fields ──────────────────────────────────────────────
    # office_id ↔ mst_office.officeid  (5-char primary office code, e.g. 'DGDES')
    office_id    = models.CharField(max_length=5, unique=True, blank=True,
                       help_text='5-character office code from mst_office (e.g. DGDES, PRDSC)')
    # level ↔ officelevelid (2-char code stored in LEVEL_CHOICES above)
    office_level_code = models.CharField(max_length=2, blank=True,
                            help_text='Raw officelevelid from mst_office (e.g. L1, L2)')
    # controllingoffice → separate FK (may differ from parentofficeid)
    controlling_office = models.ForeignKey(
        'self', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='controlled_offices',
        help_text='mst_office.controllingoffice — administrative controlling authority'
    )
    office_url   = models.URLField(max_length=75, blank=True)
    address1     = models.CharField(max_length=75, blank=True)
    address2     = models.CharField(max_length=75, blank=True)
    address3     = models.CharField(max_length=75, blank=True)
    circle       = models.CharField(max_length=50, blank=True,
                       help_text='Circle/Command name from mst_office')
    display_order= models.IntegerField(default=0,
                       help_text='mst_office.dorder — sort order within level')
    officer_name = models.CharField(max_length=200, blank=True)
    mobile       = models.CharField(max_length=15, blank=True)
    landline     = models.CharField(max_length=50, blank=True,
                       help_text='mst_office.phonenos')
    fax_nos      = models.CharField(max_length=25, blank=True)
    email        = models.EmailField(blank=True)
    state        = models.ForeignKey(
        'gis_layers.State', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='+'
    )
    district     = models.ForeignKey(
        'gis_layers.District', null=True, blank=True,
        on_delete=models.SET_NULL, related_name='+'
    )
    pincode      = models.CharField(max_length=6, blank=True)
    creation_date= models.DateField(null=True, blank=True,
                       help_text='mst_office.creationdate')
    close_date   = models.DateField(null=True, blank=True,
                       help_text='mst_office.closedate')
    doe          = models.DateField(null=True, blank=True,
                       help_text='Date of Establishment (mst_office.doe)')
    dou          = models.DateField(null=True, blank=True,
                       help_text='Date of last Update (mst_office.dou)')
    # Audit trail from mst_office
    enby         = models.CharField(max_length=15, blank=True,
                       help_text='Entered-by user code from mst_office')
    upby         = models.CharField(max_length=15, blank=True,
                       help_text='Updated-by user code from mst_office')
    csum         = models.TextField(blank=True,
                       help_text='Checksum from mst_office')

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['level', 'name']

    def __str__(self):
        return f"{self.get_level_display()} — {self.name}"

    def get_subtree_ids(self) -> list[int]:
        """Return IDs of self + all children + all grandchildren (covers full 5-level tree)."""
        child_ids = list(self.subordinates.values_list('id', flat=True))
        grandchild_ids = list(
            Organisation.objects.filter(parent_id__in=child_ids).values_list('id', flat=True)
        )
        return [self.id] + child_ids + grandchild_ids


class User(AbstractUser):
    # ── Roles ────────────────────────────────────────────────────────
    SUPERADMIN  = 'SUPERADMIN'   # Full access — DGDE level system admin
    PDDE_VIEWER = 'PDDE_VIEWER'  # Read-only, scoped to own PDDE + subtree
    VIEWER      = 'VIEWER'       # Read-only, own org only

    DEO_ADMIN   = 'DEO_ADMIN'    # Manage users/publish at DEO level
    CEO_ADMIN   = 'CEO_ADMIN'    # Manage users/publish at CEO (Cantonment) level
    ADEO_ADMIN  = 'ADEO_ADMIN'   # Manage users/publish at ADEO (Sub-area) level

    SDO         = 'SDO'          # GIS data entry at DEO level; forward projects
    SURVEYOR    = 'SURVEYOR'     # GIS data entry at CEO/ADEO level; forward projects

    CHECKER     = 'CHECKER'      # Verify submissions; send to approver or return
    APPROVER    = 'APPROVER'     # Approve or return with remarks

    ROLE_CHOICES = [
        (SUPERADMIN,  'Superadmin'),
        (PDDE_VIEWER, 'PDDE Viewer'),
        (VIEWER,      'Viewer'),
        (DEO_ADMIN,   'DEO Admin'),
        (CEO_ADMIN,   'CEO Admin'),
        (ADEO_ADMIN,  'ADEO Admin'),
        (SDO,         'SDO'),
        (SURVEYOR,    'Surveyor'),
        (CHECKER,     'Checker'),
        (APPROVER,    'Approver'),
    ]

    # Roles that can administer users within their own org
    ADMIN_ROLES = (SUPERADMIN, DEO_ADMIN, CEO_ADMIN, ADEO_ADMIN)

    organisation = models.ForeignKey(
        Organisation, on_delete=models.PROTECT,
        null=True, blank=True, related_name='users'
    )
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default=SDO)
    employee_id = models.CharField(max_length=20, unique=True, null=True, blank=True)
    phone = models.CharField(max_length=15, blank=True)
    designation = models.CharField(max_length=100, blank=True)
    sha512_password = models.CharField(max_length=128, blank=True, default='',
        help_text='SHA-512 hex digest of the raw password; used for challenge-response login')

    class Meta:
        db_table = 'accounts_user'
        indexes = [
            models.Index(fields=['organisation', 'role']),
        ]

    def set_password(self, raw_password):
        if raw_password is not None:
            self.sha512_password = hashlib.sha512(raw_password.encode('utf-8')).hexdigest()
        else:
            self.sha512_password = ''
        super().set_password(raw_password)

    def __str__(self):
        return f"{self.get_full_name() or self.username} ({self.get_role_display()})"

    # ── Convenience properties ───────────────────────────────────────

    @property
    def is_superadmin(self):
        return self.role == self.SUPERADMIN

    @property
    def is_viewer_only(self):
        return self.role in (self.VIEWER, self.PDDE_VIEWER)

    @property
    def can_forward(self):
        """SDO/Surveyor: create GIS data and forward a project for checking."""
        return self.role in (self.SDO, self.SURVEYOR, self.SUPERADMIN)

    @property
    def can_check(self):
        """Checker: verify a submitted project, send to approver or return."""
        return self.role in (self.CHECKER, self.SUPERADMIN)

    @property
    def can_approve(self):
        """Approver: approve or return a project under review."""
        return self.role in (self.APPROVER, self.SUPERADMIN)

    @property
    def can_publish(self):
        """Admin at any office level: publish an approved project."""
        return self.role in (self.DEO_ADMIN, self.CEO_ADMIN, self.ADEO_ADMIN, self.SUPERADMIN)

    @property
    def can_manage_users(self):
        """SUPERADMIN manages all; DEO/CEO/ADEO admins manage within their org."""
        return self.role in self.ADMIN_ROLES


# ── Two-Factor Authentication ─────────────────────────────────────────────────

class TwoFactorDevice(models.Model):
    user = models.OneToOneField(
        'accounts.User', on_delete=models.CASCADE, related_name='two_factor'
    )
    secret = models.CharField(max_length=64)
    is_enabled = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"2FA for {self.user.username} ({'on' if self.is_enabled else 'off'})"


class TwoFactorPendingAuth(models.Model):
    """Short-lived pre-auth token for two-step JWT login with 2FA."""
    user = models.ForeignKey(
        'accounts.User', on_delete=models.CASCADE, related_name='pending_2fa'
    )
    token = models.UUIDField(default=uuid.uuid4, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def is_expired(self):
        return (timezone.now() - self.created_at).total_seconds() > 300  # 5 min TTL

    class Meta:
        ordering = ['-created_at']


# ── Session Management ────────────────────────────────────────────────────────

class UserSession(models.Model):
    user = models.ForeignKey(
        'accounts.User', on_delete=models.CASCADE, related_name='sessions'
    )
    jti = models.CharField(max_length=255, unique=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True)
    device_name = models.CharField(max_length=100, blank=True)
    is_revoked = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-last_used']
        indexes = [models.Index(fields=['jti']), models.Index(fields=['user', 'is_revoked'])]

    def __str__(self):
        return f"{self.user.username} — {self.device_name or 'Unknown'}"


# ── Login Audit Log ───────────────────────────────────────────────────────────

class LoginAuditLog(models.Model):
    user = models.ForeignKey(
        'accounts.User', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='login_logs'
    )
    username_attempted = models.CharField(max_length=150)
    success = models.BooleanField()
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True)
    failure_reason = models.CharField(max_length=200, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['username_attempted', 'timestamp']),
            models.Index(fields=['success', 'timestamp']),
        ]

    def __str__(self):
        return f"{'OK' if self.success else 'FAIL'} {self.username_attempted} @ {self.timestamp}"


# ── Data Export Audit Log ─────────────────────────────────────────────────────

class ExportAuditLog(models.Model):
    user = models.ForeignKey(
        'accounts.User', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='export_logs'
    )
    export_type = models.CharField(max_length=50)  # csv, geojson, shapefile, xlsx, pdf
    project = models.ForeignKey(
        'survey_projects.SurveyProject', on_delete=models.SET_NULL,
        null=True, blank=True, related_name='export_logs'
    )
    filters = models.JSONField(default=dict, blank=True)
    row_count = models.PositiveIntegerField(default=0)
    file_size_bytes = models.PositiveIntegerField(default=0)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-timestamp']
        indexes = [models.Index(fields=['user', 'timestamp'])]

    def __str__(self):
        return f"{self.user} → {self.export_type} @ {self.timestamp}"
