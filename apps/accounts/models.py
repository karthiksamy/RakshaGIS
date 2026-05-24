from django.contrib.auth.models import AbstractUser
from django.db import models


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

    class Meta:
        db_table = 'accounts_user'
        indexes = [
            models.Index(fields=['organisation', 'role']),
        ]

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
