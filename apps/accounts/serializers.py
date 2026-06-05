from django.contrib.auth.hashers import make_password
from rest_framework import serializers
from .models import Organisation, User, UserSession, LoginAuditLog, ExportAuditLog


class OrganisationSerializer(serializers.ModelSerializer):
    parent_name    = serializers.CharField(source='parent.name', read_only=True)
    level_display  = serializers.CharField(source='get_level_display', read_only=True)
    state_name     = serializers.CharField(source='state.name', read_only=True)
    district_name  = serializers.CharField(source='district.name', read_only=True)

    class Meta:
        model = Organisation
        fields = [
            'id', 'name', 'code', 'level', 'level_display',
            'parent', 'parent_name', 'address',
            'default_basemap', 'created_at',
            'office_id', 'officer_name', 'mobile', 'landline', 'email',
            'state', 'state_name', 'district', 'district_name', 'pincode',
        ]
        read_only_fields = ['created_at']

    def validate(self, data):
        state = data.get('state') or (self.instance.state if self.instance else None)
        district = data.get('district') or (self.instance.district if self.instance else None)
        if district and state and district.state_id != state.pk:
            raise serializers.ValidationError(
                {'district': 'District does not belong to the selected state.'}
            )
        return data


class UserSerializer(serializers.ModelSerializer):
    organisation_name = serializers.CharField(source='organisation.name', read_only=True)
    full_name = serializers.SerializerMethodField()
    password_sha512 = serializers.CharField(write_only=True, required=False)

    def get_full_name(self, obj):
        return obj.get_full_name() or obj.username

    class Meta:
        model = User
        fields = [
            'id', 'username', 'first_name', 'last_name', 'full_name', 'email',
            'employee_id', 'role', 'organisation', 'organisation_name',
            'phone', 'designation', 'is_active', 'password_sha512',
        ]
        read_only_fields = ['id']

    def _apply_password(self, user, pw_sha512):
        if pw_sha512:
            user.sha512_password = pw_sha512
            user.password = make_password(pw_sha512)
            user.save(update_fields=['password', 'sha512_password'])

    def create(self, validated_data):
        pw_sha512 = validated_data.pop('password_sha512', None)
        user = super().create(validated_data)
        self._apply_password(user, pw_sha512)
        return user

    def update(self, instance, validated_data):
        pw_sha512 = validated_data.pop('password_sha512', None)
        user = super().update(instance, validated_data)
        self._apply_password(user, pw_sha512)
        return user


class UserProfileSerializer(serializers.ModelSerializer):
    organisation_name = serializers.CharField(source='organisation.name', read_only=True)
    organisation_level = serializers.CharField(source='organisation.level', read_only=True)
    full_name = serializers.SerializerMethodField()
    two_factor_enabled = serializers.SerializerMethodField()

    def get_full_name(self, obj):
        return obj.get_full_name() or obj.username

    def get_two_factor_enabled(self, obj):
        try:
            return obj.two_factor.is_enabled
        except Exception:
            return False

    class Meta:
        model = User
        fields = [
            'id', 'username', 'first_name', 'last_name', 'full_name', 'email',
            'employee_id', 'role', 'organisation', 'organisation_name', 'organisation_level',
            'phone', 'designation', 'two_factor_enabled',
        ]
        read_only_fields = fields


class UserSessionSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserSession
        fields = ['id', 'jti', 'ip_address', 'device_name', 'user_agent', 'created_at', 'last_used', 'is_revoked']
        read_only_fields = fields


class LoginAuditLogSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True, default='')

    class Meta:
        model = LoginAuditLog
        fields = ['id', 'user', 'username', 'username_attempted', 'success', 'ip_address',
                  'user_agent', 'failure_reason', 'timestamp']
        read_only_fields = fields


class ExportAuditLogSerializer(serializers.ModelSerializer):
    user_name = serializers.CharField(source='user.get_full_name', read_only=True, default='')
    project_number = serializers.CharField(source='project.project_number', read_only=True, default='')

    class Meta:
        model = ExportAuditLog
        fields = ['id', 'user', 'user_name', 'export_type', 'project', 'project_number',
                  'filters', 'row_count', 'file_size_bytes', 'timestamp']
        read_only_fields = fields
