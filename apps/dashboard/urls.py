from django.urls import path
from .views import (
    DashboardStatsView, GlobalSearchView, SurveyAreaProgressView, SLAReportView,
    OrgDrilldownView,
)

urlpatterns = [
    path('stats/',                 DashboardStatsView.as_view(),      name='dashboard-stats'),
    path('search/',                GlobalSearchView.as_view(),        name='global-search'),
    path('survey-areas/progress/', SurveyAreaProgressView.as_view(), name='survey-area-progress'),
    path('sla/',                   SLAReportView.as_view(),           name='sla-report'),
    path('org-drilldown/',         OrgDrilldownView.as_view(),        name='org-drilldown'),
]
