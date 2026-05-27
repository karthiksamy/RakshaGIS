from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import InvalidToken


class SessionAwareJWTAuthentication(JWTAuthentication):
    """
    Extends SimpleJWT to reject tokens whose UserSession record is revoked.
    Falls back to standard auth if jti is not tracked (backwards compat).
    """

    def get_user(self, validated_token):
        user = super().get_user(validated_token)
        jti = validated_token.get('jti')
        if jti:
            from .models import UserSession
            session = UserSession.objects.filter(jti=jti).first()
            if session and session.is_revoked:
                raise InvalidToken('Token has been revoked.')
        return user
