from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import (
    OrganisationViewSet, UserViewSet,
    AuthChallengeView, CustomLoginView, TwoFactorCompleteView, TwoFactorSetupView,
    TwoFactorSetupBeginView, TwoFactorSetupCompleteView,
    UserSessionViewSet, LoginAuditLogViewSet, ExportAuditLogViewSet,
)

router = DefaultRouter()
router.register('organisations', OrganisationViewSet, basename='organisation')
router.register('users', UserViewSet, basename='user')
router.register('sessions', UserSessionViewSet, basename='user-session')
router.register('login-audit', LoginAuditLogViewSet, basename='login-audit')
router.register('export-audit', ExportAuditLogViewSet, basename='export-audit')

urlpatterns = router.urls + [
    path('auth/challenge/', AuthChallengeView.as_view(), name='auth-challenge'),
    path('auth/login/', CustomLoginView.as_view(), name='custom-login'),
    path('auth/2fa/complete/', TwoFactorCompleteView.as_view(), name='2fa-complete'),
    path('auth/2fa/setup/', TwoFactorSetupView.as_view(), name='2fa-setup'),
    path('auth/2fa/setup-begin/', TwoFactorSetupBeginView.as_view(), name='2fa-setup-begin'),
    path('auth/2fa/setup-complete/', TwoFactorSetupCompleteView.as_view(), name='2fa-setup-complete'),
]
