from datetime import timedelta

from django.db.models import Count, Q, Max
from django.db.models.functions import TruncMonth
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Organisation, User
from apps.survey_projects.models import GISFeature, SurveyArea, SurveyProject
from apps.workflow.models import WorkflowStep


class DashboardStatsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user

        if user.is_superadmin:
            projects = SurveyProject.objects.all()
        elif user.organisation:
            org_ids = user.organisation.get_subtree_ids()
            projects = SurveyProject.objects.filter(
                Q(organisation_id__in=org_ids) | Q(shares__granted_to_id__in=org_ids)
            ).distinct()
        else:
            projects = SurveyProject.objects.none()

        project_stats = projects.aggregate(
            total=Count('id'),
            draft=Count('id', filter=Q(status='DRAFT')),
            submitted=Count('id', filter=Q(status='SUBMITTED')),
            under_review=Count('id', filter=Q(status='UNDER_REVIEW')),
            approved=Count('id', filter=Q(status='APPROVED')),
            published=Count('id', filter=Q(status='PUBLISHED')),
            returned=Count('id', filter=Q(status='RETURNED')),
        )

        feature_count = GISFeature.objects.filter(
            project__in=projects, is_deleted=False
        ).count()

        user_count = None
        org_count = None
        if user.is_superadmin:
            user_count = User.objects.filter(is_active=True).count()
            org_count = Organisation.objects.count()
        elif user.organisation:
            user_count = User.objects.filter(
                organisation_id__in=user.organisation.get_subtree_ids(), is_active=True
            ).count()

        # Recent projects (7 days)
        recent = projects.filter(
            created_at__gte=timezone.now() - timedelta(days=7)
        ).order_by('-created_at')[:5]

        # Monthly creation trend (6 months)
        monthly = (
            projects
            .filter(created_at__gte=timezone.now() - timedelta(days=180))
            .annotate(month=TruncMonth('created_at'))
            .values('month')
            .annotate(count=Count('id'))
            .order_by('month')
        )

        # Recent workflow actions — primary at survey-area level
        if user.is_superadmin:
            recent_actions = WorkflowStep.objects.select_related(
                'project', 'survey_area__project', 'actor'
            ).order_by('-timestamp')[:12]
        elif user.organisation:
            org_ids = user.organisation.get_subtree_ids()
            recent_actions = WorkflowStep.objects.filter(
                Q(project__organisation_id__in=org_ids) |
                Q(survey_area__project__organisation_id__in=org_ids)
            ).select_related(
                'project', 'survey_area__project', 'actor'
            ).distinct().order_by('-timestamp')[:12]
        else:
            recent_actions = WorkflowStep.objects.none()

        def _activity_item(ws):
            proj = ws.project or (ws.survey_area.project if ws.survey_area else None)
            return {
                'id': ws.id,
                'project_number': proj.project_number if proj else '—',
                'project_name': proj.name if proj else '—',
                'survey_area_name': ws.survey_area.name if ws.survey_area else None,
                'survey_area_status': ws.survey_area.status if ws.survey_area else None,
                'action': ws.get_action_display(),
                'actor': ws.actor.get_full_name() or ws.actor.username,
                'timestamp': ws.timestamp.isoformat(),
            }

        # ── Survey-area progress stats ─────────────────────────────────────────
        areas = SurveyArea.objects.filter(project__in=projects)
        area_stats = areas.aggregate(
            total=Count('id'),
            draft=Count('id', filter=Q(status='DRAFT')),
            submitted=Count('id', filter=Q(status='SUBMITTED')),
            under_review=Count('id', filter=Q(status='UNDER_REVIEW')),
            approved=Count('id', filter=Q(status='APPROVED')),
            published=Count('id', filter=Q(status='PUBLISHED')),
            returned=Count('id', filter=Q(status='RETURNED')),
        )

        # Overdue: submitted/under_review for > 5 days with no workflow action
        overdue_threshold = timezone.now() - timedelta(days=5)
        overdue_areas = (
            areas.filter(status__in=['SUBMITTED', 'UNDER_REVIEW'])
            .annotate(last_action=Max('workflow_steps__timestamp'))
            .filter(Q(last_action__lt=overdue_threshold) | Q(last_action__isnull=True))
            .select_related('project')
            .order_by('last_action')[:10]
        )

        # Pending work per role
        pending_checker = areas.filter(status='SUBMITTED').count()
        pending_approver = areas.filter(status='UNDER_REVIEW').count()

        # Top 5 most-active projects (by area count)
        top_projects = (
            areas.values('project__id', 'project__project_number', 'project__name')
            .annotate(area_count=Count('id'), published=Count('id', filter=Q(status='PUBLISHED')))
            .order_by('-area_count')[:5]
        )

        return Response({
            'projects': project_stats,
            'feature_count': feature_count,
            'user_count': user_count,
            'org_count': org_count,
            'recent_projects': [
                {
                    'id': p.id,
                    'project_number': p.project_number,
                    'name': p.name,
                    'status': p.status,
                    'created_at': p.created_at.isoformat(),
                }
                for p in recent
            ],
            'monthly_trend': [
                {'month': m['month'].strftime('%b %Y'), 'count': m['count']}
                for m in monthly
            ],
            'recent_activity': [_activity_item(ws) for ws in recent_actions],
            'survey_areas': area_stats,
            'pending_checker': pending_checker,
            'pending_approver': pending_approver,
            'overdue_areas': [
                {
                    'id': a.id,
                    'name': a.name,
                    'status': a.status,
                    'project_number': a.project.project_number,
                    'project_id': a.project.id,
                    'days_stuck': (timezone.now() - (a.last_action or a.updated_at)).days,
                }
                for a in overdue_areas
            ],
            'top_projects': [
                {
                    'id': tp['project__id'],
                    'project_number': tp['project__project_number'],
                    'name': tp['project__name'],
                    'area_count': tp['area_count'],
                    'published': tp['published'],
                }
                for tp in top_projects
            ],
        })


class SurveyAreaProgressView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        project_id = request.query_params.get('project')

        if user.is_superadmin:
            projects = SurveyProject.objects.all()
        elif user.organisation:
            org_ids = user.organisation.get_subtree_ids()
            projects = SurveyProject.objects.filter(
                Q(organisation_id__in=org_ids) | Q(shares__granted_to_id__in=org_ids)
            ).distinct()
        else:
            projects = SurveyProject.objects.none()

        if project_id:
            projects = projects.filter(id=project_id)

        areas = SurveyArea.objects.filter(project__in=projects)

        area_stats = areas.aggregate(
            total=Count('id'),
            draft=Count('id', filter=Q(status='DRAFT')),
            submitted=Count('id', filter=Q(status='SUBMITTED')),
            under_review=Count('id', filter=Q(status='UNDER_REVIEW')),
            approved=Count('id', filter=Q(status='APPROVED')),
            published=Count('id', filter=Q(status='PUBLISHED')),
            returned=Count('id', filter=Q(status='RETURNED')),
        )

        return Response(area_stats)


class GlobalSearchView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        q = request.query_params.get('q', '').strip()
        if len(q) < 2:
            return Response({'projects': [], 'features': [], 'users': []})

        user = request.user

        if user.is_superadmin:
            projects = SurveyProject.objects.all()
        elif user.organisation:
            org_ids = user.organisation.get_subtree_ids()
            projects = SurveyProject.objects.filter(organisation_id__in=org_ids)
        else:
            projects = SurveyProject.objects.none()

        matched_projects = projects.filter(
            Q(name__icontains=q) | Q(project_number__icontains=q) | Q(description__icontains=q)
        ).order_by('-created_at')[:10]

        matched_features = GISFeature.objects.filter(
            project__in=projects, is_deleted=False
        ).filter(
            Q(feature_id__icontains=q) | Q(layer_name__icontains=q)
        )[:10]

        matched_areas = SurveyArea.objects.filter(
            project__in=projects
        ).filter(
            Q(name__icontains=q) | Q(area_code__icontains=q) | Q(description__icontains=q)
        ).select_related('project', 'assigned_to')[:10]

        matched_users = []
        if user.can_manage_users:
            if user.is_superadmin:
                user_qs = User.objects.all()
            elif user.organisation:
                user_qs = User.objects.filter(
                    organisation_id__in=user.organisation.get_subtree_ids()
                )
            else:
                user_qs = User.objects.none()
            matched_users = user_qs.filter(
                Q(username__icontains=q)
                | Q(first_name__icontains=q)
                | Q(last_name__icontains=q)
                | Q(employee_id__icontains=q)
            )[:5]

        return Response({
            'projects': [
                {
                    'id': p.id,
                    'project_number': p.project_number,
                    'name': p.name,
                    'status': p.status,
                }
                for p in matched_projects
            ],
            'features': [
                {
                    'id': f.id,
                    'feature_id': f.feature_id,
                    'layer_name': f.layer_name,
                    'project_id': f.project_id,
                    'geometry_type': f.geometry_type,
                }
                for f in matched_features
            ],
            'survey_areas': [
                {
                    'id': a.id,
                    'name': a.name,
                    'area_code': a.area_code,
                    'description': a.description,
                    'status': a.status,
                    'project_id': a.project_id,
                    'project_name': a.project.name,
                    'project_number': a.project.project_number,
                    'assigned_to': a.assigned_to.get_full_name() if a.assigned_to else None,
                    'created_at': a.created_at.isoformat(),
                }
                for a in matched_areas
            ],
            'users': [
                {
                    'id': u.id,
                    'username': u.username,
                    'full_name': u.get_full_name(),
                    'role': u.role,
                }
                for u in matched_users
            ],
        })
