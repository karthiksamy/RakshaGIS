from rest_framework import serializers
from .models import Organisation, User


class OrganisationSerializer(serializers.ModelSerializer):
    parent_name    = serializers.CharField(source='parent.name', read_only=True)
    level_display  = serializers.CharField(source='get_level_display', read_only=True)

    class Meta:
        model = Organisation
        fields = [
            'id', 'name', 'code', 'level', 'level_display',
            'parent', 'parent_name', 'address',
            'default_basemap', 'created_at',
        ]
        read_only_fields = ['created_at']


class UserSerializer(serializers.ModelSerializer):
    organisation_name = serializers.CharField(source='organisation.name', read_only=True)
    password = serializers.CharField(write_only=True, required=False)

    class Meta:
        model = User
        fields = [
            'id', 'username', 'first_name', 'last_name', 'email',
            'employee_id', 'role', 'organisation', 'organisation_name',
            'phone', 'designation', 'is_active', 'password',
        ]
        read_only_fields = ['id']

    def create(self, validated_data):
        password = validated_data.pop('password', None)
        user = super().create(validated_data)
        if password:
            user.set_password(password)
            user.save()
        return user

    def update(self, instance, validated_data):
        password = validated_data.pop('password', None)
        user = super().update(instance, validated_data)
        if password:
            user.set_password(password)
            user.save()
        return user


class UserProfileSerializer(serializers.ModelSerializer):
    organisation_name = serializers.CharField(source='organisation.name', read_only=True)
    organisation_level = serializers.CharField(source='organisation.level', read_only=True)

    class Meta:
        model = User
        fields = [
            'id', 'username', 'first_name', 'last_name', 'email',
            'employee_id', 'role', 'organisation', 'organisation_name', 'organisation_level',
            'phone', 'designation',
        ]
        read_only_fields = fields
