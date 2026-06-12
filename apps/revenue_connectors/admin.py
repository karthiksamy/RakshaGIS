from django.contrib import admin
from django.utils import timezone
from .models import RevenuePortalConnector, ParcelRevenueLink


@admin.register(RevenuePortalConnector)
class RevenuePortalConnectorAdmin(admin.ModelAdmin):
    list_display  = ['name', 'portal_type', 'state', 'organisation',
                     'is_active', 'test_status', 'last_tested_at']
    list_filter   = ['portal_type', 'auth_type', 'is_active', 'test_status', 'state']
    search_fields = ['name', 'base_url', 'layer_name']
    readonly_fields = ['test_status', 'test_message', 'last_tested_at',
                       'created_by', 'created_at', 'updated_at']
    fieldsets = [
        (None, {'fields': ['name', 'portal_type', 'state', 'organisation', 'is_active']}),
        ('Endpoint', {'fields': ['base_url', 'layer_name']}),
        ('Authentication', {'fields': ['auth_type', 'api_key', 'username', 'password']}),
        ('Portal Parameters', {'fields': ['extra_params']}),
        ('Connection Status', {'fields': ['test_status', 'test_message', 'last_tested_at']}),
        ('Audit', {'fields': ['created_by', 'created_at', 'updated_at'],
                   'classes': ['collapse']}),
    ]
    actions = ['test_connectors']

    def save_model(self, request, obj, form, change):
        if not obj.pk:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)

    @admin.action(description='Test selected connectors')
    def test_connectors(self, request, queryset):
        from .connectors import test_connector
        for conn in queryset:
            ok, msg = test_connector(conn)
            conn.test_status    = RevenuePortalConnector.STATUS_OK if ok else RevenuePortalConnector.STATUS_ERROR
            conn.test_message   = msg
            conn.last_tested_at = timezone.now()
            conn.save(update_fields=['test_status', 'test_message', 'last_tested_at'])
        self.message_user(request, f'{queryset.count()} connector(s) tested.')


@admin.register(ParcelRevenueLink)
class ParcelRevenueLinkAdmin(admin.ModelAdmin):
    list_display  = ['defence_parcel', 'connector', 'remote_survey_number',
                     'remote_owner', 'overlap_pct', 'discrepancy_flag', 'fetched_at']
    list_filter   = ['discrepancy_flag', 'connector__portal_type', 'connector']
    search_fields = ['remote_survey_number', 'remote_owner', 'defence_parcel__survey_number']
    readonly_fields = [f.name for f in ParcelRevenueLink._meta.get_fields()
                       if hasattr(f, 'name')]
