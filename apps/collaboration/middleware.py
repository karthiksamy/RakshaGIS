"""
JWT authentication middleware for Django Channels WebSocket connections.
Reads the token from the `?token=<jwt>` query parameter and injects the
authenticated user into `scope['user']`.
"""

from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser


@database_sync_to_async
def _get_user(token_str: str):
    try:
        from rest_framework_simplejwt.tokens import AccessToken
        from django.contrib.auth import get_user_model
        User = get_user_model()
        token = AccessToken(token_str)
        return User.objects.get(id=token.payload['user_id'])
    except Exception:
        return AnonymousUser()


class JWTAuthMiddleware:
    """ASGI middleware that authenticates WebSocket connections via JWT query param."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'websocket':
            qs = parse_qs(scope.get('query_string', b'').decode())
            token_list = qs.get('token', [])
            scope['user'] = (
                await _get_user(token_list[0]) if token_list else AnonymousUser()
            )
        return await self.app(scope, receive, send)
