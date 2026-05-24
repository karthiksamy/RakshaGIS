from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import Organisation, User


@admin.register(Organisation)
class OrganisationAdmin(admin.ModelAdmin):
    list_display = ['name', 'code', 'level', 'parent']
    list_filter = ['level']
    search_fields = ['name', 'code']


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ['username', 'get_full_name', 'role', 'organisation', 'is_active']
    list_filter = ['role', 'organisation__level', 'is_active']
    search_fields = ['username', 'first_name', 'last_name', 'email']
    fieldsets = BaseUserAdmin.fieldsets + (
        ('RakshaGIS', {'fields': ('role', 'organisation', 'phone', 'designation')}),
    )
    add_fieldsets = BaseUserAdmin.add_fieldsets + (
        ('RakshaGIS', {'fields': ('role', 'organisation', 'phone', 'designation')}),
    )
