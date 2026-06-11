"""
Real-time collaboration WebSocket consumer.

Each survey project gets a dedicated "room" — a channels group named
`project_{id}`.  All surveyors connected to the same project receive each
other's feature edits, deletions, and presence events in real time.

Connection URL:  ws[s]://<host>/ws/project/<project_id>/?token=<jwt_access_token>

Message types (client → server):
  feature_created   — { type, feature: {id, geometry, layer_name, attributes, ...} }
  feature_updated   — { type, feature_id, geometry, attributes }
  feature_deleted   — { type, feature_id }
  feature_lock      — { type, feature_id }     acquire edit lock
  feature_unlock    — { type, feature_id }     release edit lock
  activity_update   — { type, activity, tool_key, project_id, survey_area_id, survey_area_name }
  cursor            — { type, lng, lat }        live cursor (optional)

Message types (server → client):
  presence          — { type, event: joined|left, user: {id,name,color,activity} }
  presence_activity — { type, user_id, activity }   live status update
  room_state        — { type, users, locked_features }
  feature_created   — { type, feature, sender_id }
  feature_updated   — { type, feature_id, geometry, attributes, sender_id }
  feature_deleted   — { type, feature_id, sender_id }
  feature_locked    — { type, feature_id, user }
  feature_unlocked  — { type, feature_id, sender_id }
  cursor            — { type, user_id, lng, lat }
  error             — { type, detail }
"""

import json

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async

# Module-level presence & lock stores (single-process; safe for Daphne's async model)
# _PRESENCE[room_group] = {channel_name: user_info_dict}
# _LOCKS[room_group]    = {feature_id_str: user_info_dict}
_PRESENCE: dict[str, dict] = {}
_LOCKS:    dict[str, dict] = {}


def _user_color(user_id: int) -> str:
    """Deterministic HSL colour for a user based on their ID."""
    hue = int((user_id * 137.508) % 360)
    return f'hsl({hue},70%,55%)'


class ProjectRoomConsumer(AsyncWebsocketConsumer):

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def connect(self):
        project_id = self.scope['url_route']['kwargs']['project_id']
        self.room_group = f'project_{project_id}'
        self.project_id = int(project_id)

        # Authenticate
        user = self.scope.get('user')
        if user is None or not user.is_authenticated:
            await self.close(code=4001)
            return
        self.user = user
        self.user_color = _user_color(user.id)
        self.user_info = {
            'id': user.id,
            'name': user.get_full_name() or user.username,
            'color': self.user_color,
        }

        # Check project access
        has_access = await self._check_project_access()
        if not has_access:
            await self.close(code=4003)
            return

        # Register presence (activity starts as 'Viewing')
        self.user_info['activity'] = 'Viewing'
        _PRESENCE.setdefault(self.room_group, {})[self.channel_name] = self.user_info
        _LOCKS.setdefault(self.room_group, {})

        await self.channel_layer.group_add(self.room_group, self.channel_name)
        await self.accept()

        # Send current room state to this new joiner
        await self.send(json.dumps({
            'type': 'room_state',
            'users': list(_PRESENCE[self.room_group].values()),
            'locked_features': {
                fid: info for fid, info in _LOCKS[self.room_group].items()
            },
        }))

        # Broadcast join to others
        await self.channel_layer.group_send(self.room_group, {
            'type': 'collab.presence',
            'event': 'joined',
            'user': self.user_info,
            'sender': self.channel_name,
        })

    async def disconnect(self, close_code):
        # Guard: connect() may have been rejected before setting these attributes
        if not hasattr(self, 'room_group') or not hasattr(self, 'user_info'):
            return

        # Release all locks held by this user
        room_locks = _LOCKS.get(self.room_group, {})
        released_features = [
            fid for fid, info in list(room_locks.items())
            if info.get('channel') == self.channel_name
        ]
        for fid in released_features:
            del room_locks[fid]
            await self.channel_layer.group_send(self.room_group, {
                'type': 'collab.feature_unlocked',
                'feature_id': int(fid),
                'sender_id': self.user.id,
                'sender': self.channel_name,
            })

        # Remove from presence
        room_presence = _PRESENCE.get(self.room_group, {})
        room_presence.pop(self.channel_name, None)

        await self.channel_layer.group_send(self.room_group, {
            'type': 'collab.presence',
            'event': 'left',
            'user': self.user_info,
            'sender': self.channel_name,
        })
        await self.channel_layer.group_discard(self.room_group, self.channel_name)

    # ── Receive from client ───────────────────────────────────────────────────

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
        except (json.JSONDecodeError, ValueError):
            await self.send_error('Invalid JSON')
            return

        msg_type = data.get('type', '')

        if msg_type == 'feature_created':
            feature = data.get('feature', {})
            await self.channel_layer.group_send(self.room_group, {
                'type': 'collab.feature_created',
                'feature': feature,
                'sender_id': self.user.id,
                'sender': self.channel_name,
            })
            await self._log_activity(
                action='CREATE_FEATURE',
                activity_label='Created Feature',
                project_id=self.project_id,
                survey_area_id=data.get('survey_area_id'),
                feature_id=feature.get('id'),
                layer_name=feature.get('layer_name', ''),
                detail={'geometry_type': feature.get('geometry_type', '')},
            )

        elif msg_type == 'feature_updated':
            await self.channel_layer.group_send(self.room_group, {
                'type': 'collab.feature_updated',
                'feature_id': data.get('feature_id'),
                'geometry': data.get('geometry'),
                'attributes': data.get('attributes'),
                'sender_id': self.user.id,
                'sender': self.channel_name,
            })
            await self._log_activity(
                action='EDIT_FEATURE',
                activity_label='Edited Feature',
                project_id=self.project_id,
                survey_area_id=data.get('survey_area_id'),
                feature_id=data.get('feature_id'),
                layer_name=data.get('layer_name', ''),
            )

        elif msg_type == 'feature_deleted':
            await self.channel_layer.group_send(self.room_group, {
                'type': 'collab.feature_deleted',
                'feature_id': data.get('feature_id'),
                'sender_id': self.user.id,
                'sender': self.channel_name,
            })
            await self._log_activity(
                action='DELETE_FEATURE',
                activity_label='Deleted Feature',
                project_id=self.project_id,
                survey_area_id=data.get('survey_area_id'),
                feature_id=data.get('feature_id'),
            )

        elif msg_type == 'feature_lock':
            feature_id = str(data.get('feature_id', ''))
            room_locks = _LOCKS.get(self.room_group, {})
            existing = room_locks.get(feature_id)

            if existing and existing.get('channel') != self.channel_name:
                # Already locked by someone else — reject
                await self.send(json.dumps({
                    'type': 'feature_lock_denied',
                    'feature_id': int(feature_id),
                    'locked_by': existing,
                }))
            else:
                lock_info = {**self.user_info, 'channel': self.channel_name}
                room_locks[feature_id] = lock_info
                await self.channel_layer.group_send(self.room_group, {
                    'type': 'collab.feature_locked',
                    'feature_id': int(feature_id),
                    'user': self.user_info,
                    'sender': self.channel_name,
                })

        elif msg_type == 'feature_unlock':
            feature_id = str(data.get('feature_id', ''))
            room_locks = _LOCKS.get(self.room_group, {})
            if room_locks.get(feature_id, {}).get('channel') == self.channel_name:
                del room_locks[feature_id]
                await self.channel_layer.group_send(self.room_group, {
                    'type': 'collab.feature_unlocked',
                    'feature_id': int(feature_id),
                    'sender_id': self.user.id,
                    'sender': self.channel_name,
                })

        elif msg_type == 'activity_update':
            activity = (data.get('activity') or 'Viewing')[:100]
            # Update in-memory presence
            room_presence = _PRESENCE.get(self.room_group, {})
            if self.channel_name in room_presence:
                room_presence[self.channel_name]['activity'] = activity
            # Broadcast to everyone in the room (including sender — they need to see own updates)
            await self.channel_layer.group_send(self.room_group, {
                'type': 'collab.presence_activity',
                'user_id': self.user.id,
                'activity': activity,
            })
            # Log significant tool changes to the DB audit trail
            tool_key = data.get('tool_key', '')
            if tool_key and tool_key not in ('pan', 'identify', 'coord_picker'):
                await self._log_activity(
                    action='TOOL_CHANGE',
                    activity_label=activity,
                    project_id=data.get('project_id'),
                    survey_area_id=data.get('survey_area_id'),
                    detail={'tool_key': tool_key},
                )

        elif msg_type == 'cursor':
            await self.channel_layer.group_send(self.room_group, {
                'type': 'collab.cursor',
                'user_id': self.user.id,
                'user_color': self.user_color,
                'lng': data.get('lng'),
                'lat': data.get('lat'),
                'sender': self.channel_name,
            })

    # ── Group message handlers (server → this client) ─────────────────────────

    async def collab_presence(self, event):
        if event.get('sender') == self.channel_name:
            return  # Don't echo to self
        await self.send(json.dumps({
            'type': 'presence',
            'event': event['event'],
            'user': event['user'],
        }))

    async def collab_presence_activity(self, event):
        """Broadcast a user's current activity label to every client in the room."""
        await self.send(json.dumps({
            'type': 'presence_activity',
            'user_id': event['user_id'],
            'activity': event['activity'],
        }))

    async def collab_feature_created(self, event):
        if event.get('sender') == self.channel_name:
            return
        await self.send(json.dumps({
            'type': 'feature_created',
            'feature': event['feature'],
            'sender_id': event['sender_id'],
        }))

    async def collab_feature_updated(self, event):
        if event.get('sender') == self.channel_name:
            return
        await self.send(json.dumps({
            'type': 'feature_updated',
            'feature_id': event['feature_id'],
            'geometry': event['geometry'],
            'attributes': event['attributes'],
            'sender_id': event['sender_id'],
        }))

    async def collab_feature_deleted(self, event):
        if event.get('sender') == self.channel_name:
            return
        await self.send(json.dumps({
            'type': 'feature_deleted',
            'feature_id': event['feature_id'],
            'sender_id': event['sender_id'],
        }))

    async def collab_feature_locked(self, event):
        await self.send(json.dumps({
            'type': 'feature_locked',
            'feature_id': event['feature_id'],
            'user': event['user'],
        }))

    async def collab_feature_unlocked(self, event):
        await self.send(json.dumps({
            'type': 'feature_unlocked',
            'feature_id': event['feature_id'],
            'sender_id': event['sender_id'],
        }))

    async def collab_cursor(self, event):
        if event.get('sender') == self.channel_name:
            return
        await self.send(json.dumps({
            'type': 'cursor',
            'user_id': event['user_id'],
            'user_color': event['user_color'],
            'lng': event['lng'],
            'lat': event['lat'],
        }))

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def send_error(self, detail: str):
        await self.send(json.dumps({'type': 'error', 'detail': detail}))

    @database_sync_to_async
    def _log_activity(
        self, *, action: str, activity_label: str = '',
        project_id=None, survey_area_id=None,
        feature_id=None, layer_name: str = '', detail: dict | None = None,
    ):
        from apps.workflow.models import MapActivityLog
        from apps.survey_projects.models import SurveyProject, SurveyArea
        project = None
        survey_area = None
        if project_id:
            try:
                project = SurveyProject.objects.get(id=project_id)
            except SurveyProject.DoesNotExist:
                pass
        if survey_area_id:
            try:
                survey_area = SurveyArea.objects.get(id=survey_area_id)
            except SurveyArea.DoesNotExist:
                pass
        MapActivityLog.objects.create(
            user=self.user,
            project=project,
            survey_area=survey_area,
            action=action,
            activity_label=activity_label,
            feature_id=feature_id,
            layer_name=layer_name or '',
            detail=detail or {},
        )

    @database_sync_to_async
    def _check_project_access(self) -> bool:
        """Verify user can access this project (same org or SUPERADMIN or shared)."""
        from apps.survey_projects.models import SurveyProject, ProjectShare
        from apps.accounts.models import User

        user = self.user
        if user.role == User.SUPERADMIN:
            return SurveyProject.objects.filter(id=self.project_id).exists()

        if user.organisation_id:
            if SurveyProject.objects.filter(
                id=self.project_id, organisation=user.organisation
            ).exists():
                return True
            # Check explicit project share
            if ProjectShare.objects.filter(
                project_id=self.project_id, granted_to=user.organisation
            ).exists():
                return True
        return False
