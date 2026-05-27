from django.urls import path
from .views import DashboardStatsView, GlobalSearchView

urlpatterns = [
    path('stats/', DashboardStatsView.as_view(), name='dashboard-stats'),
    path('search/', GlobalSearchView.as_view(), name='global-search'),
]
