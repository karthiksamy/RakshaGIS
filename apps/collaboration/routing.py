from django.urls import re_path
from .consumers import ProjectRoomConsumer

websocket_urlpatterns = [
    re_path(r'^ws/project/(?P<project_id>\d+)/$', ProjectRoomConsumer.as_asgi()),
]
