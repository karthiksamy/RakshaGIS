from datetime import timedelta

from django.db.models import Count, Q, Max, Prefetch
from django.db.models.functions import TruncMonth
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import Organisation, User
from apps.survey_projects.models import GISFeature, SurveyArea, SurveyProject
from apps.workflow.models import WorkflowStep

# SLA thresholds in days for each workflow transition
SLA_DAYS = {
    'draft_to_submit':    14,   # DRAFT → SUBMITTED
    'submit_to_review':   5,    # SUBMITTED → UNDER_REVIEW
    'review_to_approve':  7,    # UNDER_REVIEW → APPROVED
    'approve_to_publish': 3,    # APPROVED → PUBLISHED
}


def _sla_status(days, limit):
    if days is None:
        return None
    if days <= limit * 0.7:
        return 'OK'
    if days <= limit:
        return 'WARNING'
    return 'OVERDUE'


def _visible_org_ids(user):
    """Org scope for dashboard aggregates.

    Field offices (DEO and below) see their own subtree — the DEO rule allows
    own + subordinate office data. DGDE/PDDE office users are isolated to
    their OWN org: subordinate project/area data must reach them only through
    the published Map Viewer, never through dashboards or search.
    """
    from apps.survey_projects.access import hq_level
    if hq_level(user):
        return [user.organisation_id]
    return user.organisation.get_subtree_ids()


class DashboardStatsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user

        if user.is_superadmin:
            from apps.accounts.permissions import org_queryset_filter
            projects = org_queryset_filter(user, SurveyProject.objects.all())
        elif user.organisation:
            org_ids = _visible_org_ids(user)
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
        from apps.survey_projects.access import hq_level as _hq_level
        _sa_level = _hq_level(user)
        if user.is_superadmin and not _sa_level:
            user_count = User.objects.filter(is_active=True).count()
            org_count = Organisation.objects.count()
        elif user.organisation:
            user_count = User.objects.filter(
                organisation_id__in=_visible_org_ids(user), is_active=True
            ).count()
            if user.is_superadmin and _sa_level:
                org_count = Organisation.objects.filter(
                    id__in=user.organisation.get_subtree_ids()
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

        # Recent workflow actions — primary at survey-area level.
        # HQ (DGDE/PDDE) users ARE allowed to monitor ongoing ACTIVITY of their
        # offices (who forwarded/approved/published what) — DGDE across all
        # offices, PDDE across its command — even though project content
        # itself stays isolated.
        from apps.survey_projects.access import hq_level as _hq
        _level = _hq(user)
        if (user.is_superadmin and not _level) or _level == 'DGDE':
            recent_actions = WorkflowStep.objects.select_related(
                'project', 'survey_area__project', 'actor'
            ).order_by('-timestamp')[:12]
        elif user.organisation:
            org_ids = (user.organisation.get_subtree_ids() if _level == 'PDDE'
                       else _visible_org_ids(user))
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
            from apps.accounts.permissions import org_queryset_filter
            projects = org_queryset_filter(user, SurveyProject.objects.all())
        elif user.organisation:
            org_ids = _visible_org_ids(user)
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
            from apps.accounts.permissions import org_queryset_filter
            projects = org_queryset_filter(user, SurveyProject.objects.all())
        elif user.organisation:
            # Search returns concrete project/feature/area records — scope it
            # exactly like the projects API: own org + explicit grants only.
            from apps.survey_projects.access import permitted_extra_project_ids
            projects = SurveyProject.objects.filter(
                Q(organisation=user.organisation)
                | Q(id__in=permitted_extra_project_ids(user))
            ).distinct()
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
                from apps.survey_projects.access import hq_level as _hq_search
                _search_level = _hq_search(user)
                if _search_level and user.organisation:
                    user_qs = User.objects.filter(organisation=user.organisation)
                else:
                    user_qs = User.objects.all()
            elif user.organisation:
                user_qs = User.objects.filter(
                    organisation_id__in=_visible_org_ids(user)
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


class SLAReportView(APIView):
    """
    GET /api/dashboard/sla/
    Returns per-survey-area SLA breakdown: days in each workflow state vs. configured limits.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        status_filter = request.query_params.get('status')
        page_size = min(int(request.query_params.get('page_size', 200)), 500)

        if user.is_superadmin:
            from apps.accounts.permissions import org_queryset_filter
            projects = org_queryset_filter(user, SurveyProject.objects.all())
        elif user.organisation:
            org_ids = _visible_org_ids(user)
            projects = SurveyProject.objects.filter(organisation_id__in=org_ids)
        else:
            return Response({'results': [], 'sla_days': SLA_DAYS, 'summary': {}})

        area_qs = (
            SurveyArea.objects
            .filter(project__in=projects)
            .select_related('project__organisation', 'assigned_to')
            .prefetch_related(
                Prefetch(
                    'workflow_steps',
                    queryset=WorkflowStep.objects.order_by('timestamp')
                                .select_related('actor'),
                )
            )
            .order_by('-created_at')
        )
        if status_filter:
            area_qs = area_qs.filter(status=status_filter)

        area_qs = area_qs[:page_size]

        now = timezone.now()
        results = []
        summary = {'OK': 0, 'WARNING': 0, 'OVERDUE': 0, 'total': 0}

        for area in area_qs:
            steps = list(area.workflow_steps.all())

            def _first_ts(actions):
                for s in steps:
                    if s.action in actions:
                        return s.timestamp
                return None

            def _last_actor(actions):
                actor = None
                for s in steps:
                    if s.action in actions:
                        actor = s.actor
                return actor.get_full_name() if actor else None

            forward_at  = _first_ts(['FORWARD', 'RE_FORWARD'])
            check_at    = _first_ts(['CHECK'])
            approve_at  = _first_ts(['APPROVE'])
            publish_at  = _first_ts(['PUBLISH'])

            # Days spent in each state (still counting if not yet transitioned)
            end_draft    = forward_at  or (now if area.status == 'DRAFT'         else None)
            end_submit   = check_at    or (now if area.status == 'SUBMITTED'     else None)
            end_review   = approve_at  or (now if area.status == 'UNDER_REVIEW'  else None)
            end_approved = publish_at  or (now if area.status == 'APPROVED'      else None)

            draft_days    = (end_draft    - area.created_at).days if end_draft                else None
            submit_days   = (end_submit   - forward_at).days      if forward_at and end_submit else None
            review_days   = (end_review   - check_at).days        if check_at   and end_review else None
            approved_days = (end_approved - approve_at).days      if approve_at and end_approved else None

            sla_draft    = _sla_status(draft_days,    SLA_DAYS['draft_to_submit'])
            sla_submit   = _sla_status(submit_days,   SLA_DAYS['submit_to_review'])
            sla_review   = _sla_status(review_days,   SLA_DAYS['review_to_approve'])
            sla_approved = _sla_status(approved_days, SLA_DAYS['approve_to_publish'])

            all_statuses = [s for s in [sla_draft, sla_submit, sla_review, sla_approved] if s]
            if 'OVERDUE' in all_statuses:
                overall = 'OVERDUE'
            elif 'WARNING' in all_statuses:
                overall = 'WARNING'
            elif all_statuses:
                overall = 'OK'
            else:
                overall = 'OK'

            summary[overall] = summary.get(overall, 0) + 1
            summary['total'] += 1

            # Current state actor
            current_actor = _last_actor(['FORWARD', 'RE_FORWARD', 'CHECK', 'APPROVE', 'PUBLISH'])

            results.append({
                'area_id':       area.id,
                'area_name':     area.name,
                'project_id':    area.project_id,
                'project_number': area.project.project_number,
                'org':           area.project.organisation.name,
                'status':        area.status,
                'assigned_to':   area.assigned_to.get_full_name() if area.assigned_to else None,
                'last_actor':    current_actor,
                'created_at':    area.created_at.isoformat(),
                # Days in each state
                'draft_days':    draft_days,
                'submit_days':   submit_days,
                'review_days':   review_days,
                'approved_days': approved_days,
                # SLA status per state
                'sla_draft':     sla_draft,
                'sla_submit':    sla_submit,
                'sla_review':    sla_review,
                'sla_approved':  sla_approved,
                'overall_sla':   overall,
            })

        # Sort: overdue first, then warning, then ok
        order = {'OVERDUE': 0, 'WARNING': 1, 'OK': 2}
        results.sort(key=lambda r: order.get(r['overall_sla'], 3))

        return Response({
            'results':  results,
            'sla_days': SLA_DAYS,
            'summary':  summary,
        })


class OrgDrilldownView(APIView):
    """Hierarchical aggregate dashboard (DGDE → command → office → sub-office).

    GET /api/dashboard/org-drilldown/?org=<id>

    Returns aggregate statistics for the target office and one row per child
    office. Aggregates only — no project names or records — so HQ users can
    monitor progress down the tree without breaching office-level data
    isolation. The target must be the requesting user's own office or one of
    its descendants: DGDE drills through everything, PDDE only through its
    own command, DEO through its own offices.
    """
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _is_descendant(org, ancestor) -> bool:
        seen = set()
        cur = org
        while cur and cur.id not in seen:
            if cur.id == ancestor.id:
                return True
            seen.add(cur.id)
            cur = cur.parent
        return False

    # Offices at or below DEO show their OWN statistics only — sub-office
    # (CEO/ADEO) data is never aggregated upward or listed in the drilldown.
    _LEAF_LEVELS = (Organisation.DEO, Organisation.CEO, Organisation.ADEO)

    @classmethod
    def _scope_ids(cls, org) -> list:
        """org.id + descendants, stopping the descent at DEO level."""
        if org.level in cls._LEAF_LEVELS:
            return [org.id]
        ids = [org.id]
        frontier = [org.id]
        while frontier:
            children = list(
                Organisation.objects.filter(parent_id__in=frontier)
                .exclude(id__in=ids).values('id', 'level')
            )
            new_ids = [c['id'] for c in children]
            ids.extend(new_ids)
            frontier = [c['id'] for c in children
                        if c['level'] not in cls._LEAF_LEVELS]
        return ids

    @staticmethod
    def _org_stats(org_ids) -> dict:
        projects = SurveyProject.objects.filter(organisation_id__in=org_ids)
        areas = SurveyArea.objects.filter(project__organisation_id__in=org_ids)
        return {
            'projects': projects.count(),
            'projects_published': projects.filter(status='PUBLISHED').count(),
            'areas': areas.count(),
            'areas_published': areas.filter(status='PUBLISHED').count(),
            'areas_in_review': areas.filter(
                status__in=['SUBMITTED', 'UNDER_REVIEW']).count(),
            'features': GISFeature.objects.filter(
                project__organisation_id__in=org_ids, is_deleted=False).count(),
            'users': User.objects.filter(
                organisation_id__in=org_ids, is_active=True).count(),
        }

    def get(self, request):
        user = request.user
        # Org-attached users (incl. superadmins at an HQ office) start at their
        # own office; only an org-less superadmin starts at the national root.
        home = user.organisation
        if home is None and user.is_superadmin:
            home = Organisation.objects.filter(level=Organisation.DGDE).first()
        if home is None:
            return Response({'detail': 'No organisation assigned.'}, status=403)

        target_id = request.query_params.get('org')
        if target_id:
            try:
                target = Organisation.objects.select_related('parent').get(id=target_id)
            except Organisation.DoesNotExist:
                return Response({'detail': 'Organisation not found.'}, status=404)
            if not self._is_descendant(target, home):
                return Response({'detail': 'Outside your office scope.'}, status=403)
        else:
            target = home

        # Drilldown stops at DEO level: a DEO shows its own statistics only,
        # its CEO/ADEO sub-offices are neither listed nor aggregated.
        if target.level in self._LEAF_LEVELS:
            children = []
        else:
            children = list(
                Organisation.objects.filter(parent=target).order_by('level', 'name')
            )
        child_rows = []
        for child in children:
            child_rows.append({
                'id': child.id,
                'name': child.name,
                'level': child.level,
                'level_display': child.get_level_display(),
                'has_children': (
                    child.level not in self._LEAF_LEVELS
                    and Organisation.objects.filter(parent=child).exists()
                ),
                'stats': self._org_stats(self._scope_ids(child)),
            })

        # Breadcrumb: home → … → target (always stops at the user's own office)
        breadcrumb = []
        cur = target
        while cur:
            breadcrumb.append({'id': cur.id, 'name': cur.name, 'level': cur.level})
            if cur.id == home.id:
                break
            cur = cur.parent
        breadcrumb.reverse()

        return Response({
            'org': {'id': target.id, 'name': target.name, 'level': target.level,
                    'level_display': target.get_level_display()},
            'breadcrumb': breadcrumb,
            'own_stats': self._org_stats([target.id]),
            'total_stats': self._org_stats(self._scope_ids(target)),
            'children': child_rows,
        })
