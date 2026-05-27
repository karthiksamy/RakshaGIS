import json

from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.views import APIView
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter, OrderingFilter
from django.contrib.gis.db.models.functions import Distance
from django.contrib.gis.measure import D

from apps.accounts.permissions import CanEditProject, IsSuperAdmin, org_queryset_filter
from .models import SurveyProject, SurveyArea, GISFeature, DefenceParcel, AttributeTemplate, ShapefileImport, ProjectLayerFolder, ProjectShare, GeoTiffLayer, FeatureAttachment, ProjectMilestone
from .serializers import (
    SurveyProjectSerializer, SurveyAreaSerializer, GISFeatureSerializer, DefenceParcelSerializer,
    AttributeTemplateSerializer, ShapefileImportSerializer,
    ProjectLayerFolderSerializer, ProjectShareSerializer, GeoTiffLayerSerializer,
    BufferParcelSerializer, FeatureAttachmentSerializer, ProjectMilestoneSerializer,
)


class SurveyProjectViewSet(viewsets.ModelViewSet):
    serializer_class = SurveyProjectSerializer
    lookup_value_regex = r'\d+'
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_fields = ['status', 'survey_type', 'priority', 'organisation', 'state', 'district', 'taluk', 'village']
    search_fields = ['name', 'project_number', 'description']
    ordering_fields = ['created_at', 'updated_at', 'name', 'priority']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            SurveyProject.objects.select_related(
                'organisation', 'created_by', 'state', 'district', 'taluk', 'village'
            )
        )

    def get_permissions(self):
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            return [CanEditProject()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        # SUPERADMIN may send an explicit organisation; everyone else uses their own
        org = serializer.validated_data.get('organisation') or self.request.user.organisation
        if org is None:
            from rest_framework.exceptions import ValidationError
            raise ValidationError({'organisation': 'Organisation is required.'})
        project = serializer.save(
            created_by=self.request.user,
            organisation=org,
        )
        _create_default_folders(project, self.request.user)

    @action(detail=True, methods=['get', 'post'], url_path='active-version',
            permission_classes=[permissions.IsAuthenticated])
    def active_version(self, request, pk=None):
        """
        GET  — Return the active (latest non-final) VERSION folder for drawing.
               Auto-creates Phase I / {year} / Ver-I if none exist yet.
        POST — Force-create the next version (Ver-II, Ver-III …).
        """
        import datetime
        project = self.get_object()
        force_new = request.method == 'POST'

        if not force_new:
            # Return existing active version if available
            active = (
                ProjectLayerFolder.objects
                .filter(project=project, folder_type=ProjectLayerFolder.VERSION, is_final=False)
                .order_by('-created_at')
                .first()
            )
            if active:
                return Response(ProjectLayerFolderSerializer(active).data)

        # Count all versions (including finals) to name the next one
        version_count = ProjectLayerFolder.objects.filter(
            project=project, folder_type=ProjectLayerFolder.VERSION
        ).count()
        next_name = f'Ver-{_roman(version_count + 1)}'

        # Ensure Phase I exists
        phase = (
            ProjectLayerFolder.objects
            .filter(project=project, folder_type=ProjectLayerFolder.PHASE)
            .order_by('order')
            .first()
        )
        if not phase:
            phase = ProjectLayerFolder.objects.create(
                project=project, name='Phase I',
                folder_type=ProjectLayerFolder.PHASE,
                created_by=request.user, order=1,
            )

        # Ensure a YEAR folder exists under the phase
        current_year = datetime.date.today().year
        year_folder = (
            ProjectLayerFolder.objects
            .filter(project=project, parent=phase, folder_type=ProjectLayerFolder.YEAR)
            .order_by('-year')
            .first()
        )
        if not year_folder:
            year_folder = ProjectLayerFolder.objects.create(
                project=project, parent=phase,
                name=str(current_year),
                folder_type=ProjectLayerFolder.YEAR,
                year=current_year,
                created_by=request.user, order=0,
            )

        # Create the new VERSION folder
        new_version = ProjectLayerFolder.objects.create(
            project=project, parent=year_folder,
            name=next_name,
            folder_type=ProjectLayerFolder.VERSION,
            is_final=False,
            created_by=request.user,
            order=version_count,
        )
        return Response(ProjectLayerFolderSerializer(new_version).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['get'], url_path='export')
    def export(self, request, pk=None):
        """Export project features in various formats."""
        project = self.get_object()
        fmt = request.query_params.get('format', 'geojson').lower()
        layer_name = request.query_params.get('layer_name', None)
        folder_id = request.query_params.get('folder', None)

        qs = GISFeature.objects.filter(project=project, is_deleted=False)
        if layer_name:
            qs = qs.filter(layer_name=layer_name)
        if folder_id:
            qs = qs.filter(folder_id=folder_id)

        return _export_features(qs, project, fmt)


class GISFeatureViewSet(viewsets.ModelViewSet):
    serializer_class = GISFeatureSerializer
    lookup_value_regex = r'\d+'
    filter_backends = [DjangoFilterBackend, SearchFilter]
    filterset_fields = ['project', 'layer_name', 'geometry_type', 'is_deleted']
    search_fields = ['layer_name', 'feature_id']
    pagination_class = None  # map must load all features; pagination breaks the map layer

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            GISFeature.objects.select_related('project__organisation', 'created_by'),
            org_field='project__organisation'
        ).filter(is_deleted=False)

    def get_permissions(self):
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            return [CanEditProject()]
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

    def perform_destroy(self, instance):
        instance.is_deleted = True
        instance.save(update_fields=['is_deleted'])

    @action(detail=False, methods=['post'], url_path='rename-layer',
            permission_classes=[CanEditProject])
    def rename_layer(self, request):
        project_id = request.data.get('project')
        old_name = request.data.get('old_name', '').strip()
        new_name = request.data.get('new_name', '').strip()
        if not old_name or not new_name:
            return Response({'detail': 'old_name and new_name required.'}, status=400)
        if old_name == new_name:
            return Response({'detail': 'Names are the same.'}, status=400)
        import re
        if not re.match(r'^[A-Za-z][A-Za-z0-9_]{0,63}$', new_name):
            return Response({'detail': 'Layer name must start with a letter, max 64 chars, alphanumeric + underscore.'}, status=400)
        count = GISFeature.objects.filter(
            project_id=project_id, layer_name=old_name, is_deleted=False
        ).update(layer_name=new_name)
        return Response({'detail': f'Renamed {count} feature(s) from "{old_name}" → "{new_name}".', 'count': count})

    @action(detail=False, methods=['post'], url_path='repair-geometry',
            permission_classes=[CanEditProject])
    def repair_geometry(self, request):
        project_id = request.data.get('project')
        layer_name = request.data.get('layer_name', '').strip()
        from django.db import connection
        with connection.cursor() as cur:
            cur.execute("""
                UPDATE survey_projects_gisfeature
                   SET geometry = ST_CollectionExtract(ST_MakeValid(geometry))
                 WHERE project_id = %s
                   AND (%s = '' OR layer_name = %s)
                   AND is_deleted = FALSE
                   AND NOT ST_IsValid(geometry)
            """, [project_id, layer_name, layer_name])
            count = cur.rowcount
        return Response({'detail': f'Repaired {count} invalid geometry(ies).', 'count': count})

    @action(detail=False, methods=['post'], url_path='deduplicate',
            permission_classes=[CanEditProject])
    def deduplicate(self, request):
        project_id = request.data.get('project')
        layer_name = request.data.get('layer_name', '').strip()
        from django.db import connection
        with connection.cursor() as cur:
            cur.execute("""
                UPDATE survey_projects_gisfeature SET is_deleted = TRUE
                WHERE id IN (
                    SELECT id FROM (
                        SELECT id,
                               ROW_NUMBER() OVER (
                                   PARTITION BY ST_AsEWKB(geometry), layer_name
                                   ORDER BY id
                               ) AS rn
                        FROM survey_projects_gisfeature
                        WHERE project_id = %s
                          AND (%s = '' OR layer_name = %s)
                          AND is_deleted = FALSE
                    ) sub WHERE sub.rn > 1
                )
            """, [project_id, layer_name, layer_name])
            count = cur.rowcount
        return Response({'detail': f'Removed {count} duplicate feature(s).', 'count': count})

    @action(detail=False, methods=['post'], url_path='merge-layers',
            permission_classes=[CanEditProject])
    def merge_layers(self, request):
        project_id = request.data.get('project')
        source = request.data.get('source_layer', '').strip()
        target = request.data.get('target_layer', '').strip()
        delete_source = request.data.get('delete_source', False)
        if not source or not target:
            return Response({'detail': 'source_layer and target_layer required.'}, status=400)
        features = list(GISFeature.objects.filter(project_id=project_id, layer_name=source, is_deleted=False))
        count = 0
        for f in features:
            f.pk = None
            f.id = None
            f.layer_name = target
            f.created_by = request.user
            f.save()
            count += 1
        if delete_source:
            GISFeature.objects.filter(project_id=project_id, layer_name=source, is_deleted=False).update(is_deleted=True)
        return Response({'detail': f'Merged {count} feature(s) into "{target}".', 'count': count,
                         'source_deleted': delete_source})

    @action(detail=False, methods=['get'], url_path='layer-schema')
    def layer_schema(self, request):
        project_id = request.query_params.get('project')
        layer_name = request.query_params.get('layer_name', '')
        qs = GISFeature.objects.filter(project_id=project_id, is_deleted=False)
        if layer_name:
            qs = qs.filter(layer_name=layer_name)
        fields: dict = {}
        for f in qs[:200]:
            for k, v in (f.attributes or {}).items():
                if k not in fields:
                    if isinstance(v, bool):
                        t = 'boolean'
                    elif isinstance(v, int):
                        t = 'integer'
                    elif isinstance(v, float):
                        t = 'float'
                    else:
                        t = 'string'
                    fields[k] = {'name': k, 'type': t, 'sample': str(v)[:80] if v is not None else ''}
        total = qs.count()
        return Response({'fields': list(fields.values()), 'feature_count': total})

    @action(detail=False, methods=['post'], url_path='remove-field',
            permission_classes=[CanEditProject])
    def remove_field(self, request):
        project_id = request.data.get('project')
        layer_name = request.data.get('layer_name', '').strip()
        field_name = request.data.get('field_name', '').strip()
        if not field_name:
            return Response({'detail': 'field_name required.'}, status=400)
        qs = GISFeature.objects.filter(project_id=project_id, is_deleted=False)
        if layer_name:
            qs = qs.filter(layer_name=layer_name)
        count = 0
        for f in qs:
            if field_name in (f.attributes or {}):
                attrs = dict(f.attributes)
                del attrs[field_name]
                f.attributes = attrs
                f.save(update_fields=['attributes'])
                count += 1
        return Response({'detail': f'Removed field "{field_name}" from {count} feature(s).', 'count': count})

    @action(detail=False, methods=['post'], url_path='rename-field',
            permission_classes=[CanEditProject])
    def rename_field(self, request):
        project_id = request.data.get('project')
        layer_name = request.data.get('layer_name', '').strip()
        old_field = request.data.get('old_field', '').strip()
        new_field = request.data.get('new_field', '').strip()
        if not old_field or not new_field:
            return Response({'detail': 'old_field and new_field required.'}, status=400)
        qs = GISFeature.objects.filter(project_id=project_id, is_deleted=False)
        if layer_name:
            qs = qs.filter(layer_name=layer_name)
        count = 0
        for f in qs:
            if old_field in (f.attributes or {}):
                attrs = dict(f.attributes)
                attrs[new_field] = attrs.pop(old_field)
                f.attributes = attrs
                f.save(update_fields=['attributes'])
                count += 1
        return Response({'detail': f'Renamed field "{old_field}" → "{new_field}" on {count} feature(s).', 'count': count})

    @action(detail=False, methods=['post'], url_path='auto-geometry-stats',
            permission_classes=[CanEditProject])
    def auto_geometry_stats(self, request):
        """Compute area_m2, perimeter_m or length_m and save into feature attributes."""
        from django.db import connection
        project_id = request.data.get('project')
        layer_name = request.data.get('layer_name', '').strip()
        qs = GISFeature.objects.filter(project_id=project_id, is_deleted=False)
        if layer_name:
            qs = qs.filter(layer_name=layer_name)
        count = 0
        for f in qs:
            if f.geometry is None:
                continue
            attrs = dict(f.attributes or {})
            gt = f.geometry_type
            if gt == GISFeature.POLYGON:
                attrs['area_m2'] = round(f.geometry.transform(32643, clone=True).area, 2)
                attrs['perimeter_m'] = round(f.geometry.transform(32643, clone=True).length, 2)
            elif gt == GISFeature.LINE:
                attrs['length_m'] = round(f.geometry.transform(32643, clone=True).length, 2)
            elif gt == GISFeature.POINT:
                attrs['lat'] = round(f.geometry.y, 6)
                attrs['lon'] = round(f.geometry.x, 6)
            f.attributes = attrs
            f.save(update_fields=['attributes'])
            count += 1
        return Response({'detail': f'Updated geometry stats for {count} feature(s).', 'count': count})

    @action(detail=False, methods=['post'], url_path='dissolve',
            permission_classes=[CanEditProject])
    def dissolve(self, request):
        """Merge features with same value in dissolve_field using ST_Union. Creates new layer."""
        from django.contrib.gis.db.models import Union
        project_id = request.data.get('project')
        layer_name  = request.data.get('layer_name', '').strip()
        dissolve_field = request.data.get('dissolve_field', '').strip()
        out_layer = (request.data.get('out_layer') or f"{layer_name}_dissolved").strip()
        if not layer_name or not dissolve_field:
            return Response({'detail': 'layer_name and dissolve_field required.'}, status=400)
        qs = GISFeature.objects.filter(project_id=project_id, layer_name=layer_name, is_deleted=False)
        groups = {}
        for f in qs:
            key = (f.attributes or {}).get(dissolve_field)
            key_str = str(key) if key is not None else '__null__'
            if key_str not in groups:
                groups[key_str] = {'geoms': [], 'attr_val': key}
            groups[key_str]['geoms'].append(f.geometry)
        created = 0
        for key_str, g in groups.items():
            from django.contrib.gis.geos import GeometryCollection
            combined = g['geoms'][0]
            for gm in g['geoms'][1:]:
                try:
                    combined = combined.union(gm)
                except Exception:
                    pass
            GISFeature.objects.create(
                project_id=project_id,
                layer_name=out_layer,
                geometry=combined,
                geometry_type=GISFeature.POLYGON,
                attributes={dissolve_field: g['attr_val']},
                created_by=request.user,
            )
            created += 1
        return Response({'detail': f'Dissolved into {created} feature(s) in layer "{out_layer}".', 'created': created})

    @action(detail=False, methods=['post'], url_path='spatial-join',
            permission_classes=[CanEditProject])
    def spatial_join(self, request):
        """Join attributes from overlay_layer to features in base_layer where geometries intersect."""
        project_id    = request.data.get('project')
        base_layer    = request.data.get('base_layer', '').strip()
        overlay_layer = request.data.get('overlay_layer', '').strip()
        join_fields   = request.data.get('join_fields', [])  # list of field names to copy
        if not base_layer or not overlay_layer:
            return Response({'detail': 'base_layer and overlay_layer required.'}, status=400)
        overlay_qs = GISFeature.objects.filter(project_id=project_id, layer_name=overlay_layer, is_deleted=False)
        base_qs    = GISFeature.objects.filter(project_id=project_id, layer_name=base_layer, is_deleted=False)
        count = 0
        for bf in base_qs:
            if bf.geometry is None:
                continue
            for ov in overlay_qs:
                if ov.geometry is None:
                    continue
                try:
                    if bf.geometry.intersects(ov.geometry):
                        attrs = dict(bf.attributes or {})
                        ov_attrs = ov.attributes or {}
                        for fld in (join_fields or ov_attrs.keys()):
                            if fld in ov_attrs:
                                attrs[f"sj_{fld}"] = ov_attrs[fld]
                        bf.attributes = attrs
                        bf.save(update_fields=['attributes'])
                        count += 1
                        break  # first match only
                except Exception:
                    pass
        return Response({'detail': f'Joined attributes to {count} feature(s).', 'count': count})

    @action(detail=False, methods=['post'], url_path='clip-to-boundary',
            permission_classes=[CanEditProject])
    def clip_to_boundary(self, request):
        """Clip features in layer_name to the union of clip_layer features. Updates geometries in-place."""
        project_id  = request.data.get('project')
        layer_name  = request.data.get('layer_name', '').strip()
        clip_layer  = request.data.get('clip_layer', '').strip()
        if not layer_name or not clip_layer:
            return Response({'detail': 'layer_name and clip_layer required.'}, status=400)
        clip_geoms = list(
            GISFeature.objects.filter(project_id=project_id, layer_name=clip_layer, is_deleted=False)
            .exclude(geometry=None).values_list('geometry', flat=True)
        )
        if not clip_geoms:
            return Response({'detail': 'No clip features found.'}, status=400)
        clip_union = clip_geoms[0]
        for g in clip_geoms[1:]:
            try:
                clip_union = clip_union.union(g)
            except Exception:
                pass
        count = 0
        for f in GISFeature.objects.filter(project_id=project_id, layer_name=layer_name, is_deleted=False):
            if f.geometry is None:
                continue
            try:
                clipped = f.geometry.intersection(clip_union)
                if clipped.empty:
                    f.is_deleted = True
                    f.save(update_fields=['is_deleted'])
                else:
                    f.geometry = clipped
                    f.save(update_fields=['geometry'])
                count += 1
            except Exception:
                pass
        return Response({'detail': f'Clipped {count} feature(s) to "{clip_layer}".', 'count': count})

    @action(detail=False, methods=['get'], url_path='summary-stats')
    def summary_stats(self, request):
        """Return count + numeric field stats (sum/min/max/avg) for a layer."""
        project_id = request.query_params.get('project')
        layer_name = request.query_params.get('layer_name', '').strip()
        qs = GISFeature.objects.filter(project_id=project_id, is_deleted=False)
        if layer_name:
            qs = qs.filter(layer_name=layer_name)
        total = qs.count()
        # Collect numeric fields and compute stats in Python (attributes is JSONB)
        field_vals: dict = {}
        for f in qs:
            for k, v in (f.attributes or {}).items():
                if isinstance(v, (int, float)):
                    field_vals.setdefault(k, []).append(v)
        stats = {'feature_count': total, 'fields': {}}
        for k, vals in field_vals.items():
            stats['fields'][k] = {
                'count': len(vals),
                'sum': round(sum(vals), 4),
                'min': round(min(vals), 4),
                'max': round(max(vals), 4),
                'avg': round(sum(vals) / len(vals), 4),
            }
        return Response(stats)

    @action(detail=False, methods=['post'], url_path='near-analysis',
            permission_classes=[CanEditProject])
    def near_analysis(self, request):
        """For each feature in base_layer, find nearest feature in near_layer and store distance_m."""
        project_id  = request.data.get('project')
        base_layer  = request.data.get('base_layer', '').strip()
        near_layer  = request.data.get('near_layer', '').strip()
        if not base_layer or not near_layer:
            return Response({'detail': 'base_layer and near_layer required.'}, status=400)
        near_features = list(
            GISFeature.objects.filter(project_id=project_id, layer_name=near_layer, is_deleted=False)
            .exclude(geometry=None)
        )
        if not near_features:
            return Response({'detail': 'No near features found.'}, status=400)
        count = 0
        for bf in GISFeature.objects.filter(project_id=project_id, layer_name=base_layer, is_deleted=False):
            if bf.geometry is None:
                continue
            min_dist = None
            near_id  = None
            for nf in near_features:
                try:
                    d = bf.geometry.distance(nf.geometry)
                    # rough m conversion from degrees (~111320 m/deg)
                    d_m = round(d * 111320, 1)
                    if min_dist is None or d_m < min_dist:
                        min_dist = d_m
                        near_id  = nf.feature_id or str(nf.id)
                except Exception:
                    pass
            if min_dist is not None:
                attrs = dict(bf.attributes or {})
                attrs['near_dist_m'] = min_dist
                attrs['near_fid']    = near_id
                bf.attributes = attrs
                bf.save(update_fields=['attributes'])
                count += 1
        return Response({'detail': f'Near analysis complete for {count} feature(s).', 'count': count})

    @action(detail=False, methods=['post'], url_path='convex-hull',
            permission_classes=[CanEditProject])
    def convex_hull(self, request):
        """Generate convex hull polygon from all features in layer_name → new out_layer."""
        project_id = request.data.get('project')
        layer_name = request.data.get('layer_name', '').strip()
        out_layer  = (request.data.get('out_layer') or f"{layer_name}_hull").strip()
        if not layer_name:
            return Response({'detail': 'layer_name required.'}, status=400)
        geoms = list(
            GISFeature.objects.filter(project_id=project_id, layer_name=layer_name, is_deleted=False)
            .exclude(geometry=None).values_list('geometry', flat=True)
        )
        if not geoms:
            return Response({'detail': 'No features found.'}, status=400)
        from django.contrib.gis.geos import GeometryCollection
        collection = GeometryCollection(*geoms, srid=4326)
        hull = collection.convex_hull
        feat = GISFeature.objects.create(
            project_id=project_id,
            layer_name=out_layer,
            geometry=hull,
            geometry_type=GISFeature.POLYGON,
            attributes={'source_layer': layer_name, 'feature_count': len(geoms)},
            created_by=request.user,
        )
        return Response({'detail': f'Convex hull created in layer "{out_layer}".', 'id': feat.id})

    @action(detail=False, methods=['post'], url_path='centroid-extract',
            permission_classes=[CanEditProject])
    def centroid_extract(self, request):
        """Extract centroids from polygon layer_name → new out_layer of points."""
        project_id = request.data.get('project')
        layer_name = request.data.get('layer_name', '').strip()
        out_layer  = (request.data.get('out_layer') or f"{layer_name}_centroids").strip()
        if not layer_name:
            return Response({'detail': 'layer_name required.'}, status=400)
        qs = GISFeature.objects.filter(project_id=project_id, layer_name=layer_name, is_deleted=False).exclude(geometry=None)
        created = 0
        for f in qs:
            try:
                centroid = f.geometry.centroid
                GISFeature.objects.create(
                    project_id=project_id,
                    layer_name=out_layer,
                    geometry=centroid,
                    geometry_type=GISFeature.POINT,
                    attributes=dict(f.attributes or {}, source_id=f.feature_id or str(f.id)),
                    created_by=request.user,
                )
                created += 1
            except Exception:
                pass
        return Response({'detail': f'Extracted {created} centroid(s) to layer "{out_layer}".', 'created': created})

    @action(detail=False, methods=['post'], url_path='find-replace',
            permission_classes=[CanEditProject])
    def find_replace(self, request):
        """Search and replace a string value in a specific attribute field across a layer."""
        project_id  = request.data.get('project')
        layer_name  = request.data.get('layer_name', '').strip()
        field_name  = request.data.get('field_name', '').strip()
        find_val    = request.data.get('find_val', '')
        replace_val = request.data.get('replace_val', '')
        match_exact = request.data.get('match_exact', False)
        if not field_name:
            return Response({'detail': 'field_name required.'}, status=400)
        qs = GISFeature.objects.filter(project_id=project_id, is_deleted=False)
        if layer_name:
            qs = qs.filter(layer_name=layer_name)
        count = 0
        for f in qs:
            attrs = f.attributes or {}
            if field_name not in attrs:
                continue
            cur = str(attrs[field_name])
            if match_exact:
                if cur == str(find_val):
                    new_attrs = dict(attrs)
                    new_attrs[field_name] = replace_val
                    f.attributes = new_attrs
                    f.save(update_fields=['attributes'])
                    count += 1
            else:
                if str(find_val) in cur:
                    new_attrs = dict(attrs)
                    new_attrs[field_name] = cur.replace(str(find_val), str(replace_val))
                    f.attributes = new_attrs
                    f.save(update_fields=['attributes'])
                    count += 1
        return Response({'detail': f'Replaced in {count} feature(s).', 'count': count})


class AttributeTemplateViewSet(viewsets.ModelViewSet):
    """
    Org-scoped attribute schema definitions for GIS layers.
    SDO/SURVEYOR and admins can manage templates for their own org.
    """
    serializer_class = AttributeTemplateSerializer

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            AttributeTemplate.objects.select_related('organisation', 'created_by'),
        )

    def get_permissions(self):
        return [CanEditProject()]  # same gate: SDO/SURVEYOR + SUPERADMIN

    def perform_create(self, serializer):
        serializer.save(
            organisation=self.request.user.organisation,
            created_by=self.request.user,
        )


class ShapefileImportViewSet(viewsets.ModelViewSet):
    """Upload a .zip shapefile and trigger async import into GISFeature rows."""
    serializer_class = ShapefileImportSerializer
    http_method_names = ['get', 'post', 'head', 'options']  # no update/delete

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            ShapefileImport.objects.select_related(
                'project__organisation', 'attribute_template', 'created_by'
            ),
            org_field='project__organisation',
        )

    def get_permissions(self):
        return [CanEditProject()]

    def perform_create(self, serializer):
        from .tasks import import_shapefile
        job = serializer.save(
            created_by=self.request.user,
            status=ShapefileImport.PENDING,
        )
        import_shapefile.delay(job.id)

    @action(detail=True, methods=['post'], url_path='process-ai')
    def process_ai(self, request, pk=None):
        """Queue AI analysis of this imported layer's columns and features."""
        shp_import = self.get_object()
        if shp_import.status != ShapefileImport.DONE:
            from rest_framework.response import Response
            from rest_framework import status as drf_status
            return Response(
                {'detail': 'Import must be DONE before AI analysis.'},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        from apps.ai_assistant.models import AITask
        from apps.ai_assistant.tasks import process_shapefile_ai
        from rest_framework.response import Response
        task = AITask.objects.create(
            task_type=AITask.GIS_INDEXING,
            requested_by=request.user,
            input_data={'shapefile_import_id': shp_import.id},
        )
        # Reset processed flag while re-running
        shp_import.ai_processed = False
        shp_import.save(update_fields=['ai_processed'])
        process_shapefile_ai.delay(task.id)
        return Response({'task_id': task.id, 'detail': 'AI analysis queued.'})


class DefenceParcelViewSet(viewsets.ModelViewSet):
    serializer_class = DefenceParcelSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_fields = ['category', 'classification', 'organisation', 'state', 'district', 'taluk', 'village']
    search_fields = ['parcel_id', 'name', 'encumbrance_notes']
    ordering_fields = ['parcel_id', 'name', 'area_hectares']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            DefenceParcel.objects.select_related(
                'organisation', 'state', 'district', 'taluk', 'village', 'survey_project'
            ).prefetch_related('revenue_maps')
        )

    def get_permissions(self):
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            return [IsSuperAdmin()]
        return [permissions.IsAuthenticated()]


def _roman(n: int) -> str:
    """Convert a positive integer to uppercase Roman numerals."""
    vals = [
        (1000, 'M'), (900, 'CM'), (500, 'D'), (400, 'CD'),
        (100, 'C'), (90, 'XC'), (50, 'L'), (40, 'XL'),
        (10, 'X'), (9, 'IX'), (5, 'V'), (4, 'IV'), (1, 'I'),
    ]
    result = ''
    for v, s in vals:
        while n >= v:
            result += s
            n -= v
    return result


def _add_survey_area_subfolders(parent_folder, user):
    """
    Auto-create the three standard sub-folders under any survey-area folder:
      Shape Files  — vector GIS (zip shapefile, GeoJSON, KML, GeoPackage)
      Raster       — GeoTIFF / drone raster uploads
      Doc          — PDF, Excel, CSV, Word, images and other documents
    """
    ProjectLayerFolder.objects.get_or_create(
        project=parent_folder.project, parent=parent_folder,
        name='Shape Files', folder_type=ProjectLayerFolder.SHAPEFILE,
        defaults={'created_by': user, 'order': 0},
    )
    ProjectLayerFolder.objects.get_or_create(
        project=parent_folder.project, parent=parent_folder,
        name='Raster', folder_type=ProjectLayerFolder.RASTER,
        defaults={'created_by': user, 'order': 1},
    )
    ProjectLayerFolder.objects.get_or_create(
        project=parent_folder.project, parent=parent_folder,
        name='Doc', folder_type=ProjectLayerFolder.DOC,
        defaults={'created_by': user, 'order': 2},
    )

# Keep backward-compatible alias
_add_doc_shapefile_subfolders = _add_survey_area_subfolders


def _create_default_folders(project, user):
    common = ProjectLayerFolder.objects.create(
        project=project, name='Common Layer',
        folder_type=ProjectLayerFolder.COMMON, created_by=user, order=0,
    )
    # Revenue Map is now included in Common Layer alongside admin boundaries
    for i, name in enumerate(['State', 'District', 'Taluk', 'Village', 'Revenue Map']):
        boundary = ProjectLayerFolder.objects.create(
            project=project, parent=common, name=name,
            folder_type=ProjectLayerFolder.BOUNDARY, created_by=user, order=i,
        )
        _add_doc_shapefile_subfolders(boundary, user)


def _import_geotiff(folder, uploaded, layer_name, user):
    """Save a GeoTiff file and queue COG conversion."""
    import os
    from rest_framework.response import Response
    from .tasks import convert_geotiff_to_cog

    layer = GeoTiffLayer.objects.create(
        project=folder.project,
        folder=folder,
        name=layer_name,
        file=uploaded,
        status=GeoTiffLayer.PENDING,
        created_by=user,
    )
    try:
        convert_geotiff_to_cog.delay(layer.id)
    except Exception:
        pass  # Celery unavailable in dev — process proceeds, status stays PENDING
    return Response(
        {'detail': 'GeoTiff uploaded. COG conversion queued.', 'id': layer.id, 'type': 'geotiff'},
        status=201,
    )


def _import_shapefile_zip(folder, uploaded, layer_name, name_field, user):
    """Validate a .zip Shapefile bundle and import all features into GIS features + log ShapefileImport."""
    import io
    import os
    import tempfile
    import zipfile
    from django.contrib.gis.gdal import DataSource
    from django.contrib.gis.geos import GEOSGeometry
    from rest_framework.response import Response

    # Record the import attempt so the folder tree can show it
    shp_import = ShapefileImport.objects.create(
        project=folder.project,
        folder=folder,
        file=uploaded,
        layer_name=layer_name,
        status=ShapefileImport.RUNNING,
        created_by=user,
    )
    uploaded.seek(0)  # reset after ShapefileImport save consumed it
    data = uploaded.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return Response({'detail': 'Uploaded file is not a valid ZIP archive.'}, status=400)

    names = zf.namelist()
    # Validate required shapefile components
    def _has_ext(ext):
        return any(n.lower().endswith(ext) for n in names)

    missing = [e for e in ('.shp', '.dbf', '.shx') if not _has_ext(e)]
    if missing:
        return Response(
            {'detail': f'ZIP is missing required Shapefile component(s): {", ".join(missing)}'},
            status=400,
        )

    with tempfile.TemporaryDirectory() as tmpdir:
        zf.extractall(tmpdir)
        shp_path = next(
            os.path.join(tmpdir, n) for n in names if n.lower().endswith('.shp')
        )
        try:
            ds = DataSource(shp_path)
        except Exception as exc:
            return Response({'detail': f'Cannot read Shapefile: {exc}'}, status=400)

        created = 0
        errors = []
        project = folder.project

        for lyr in ds:
            for feat in lyr:
                try:
                    geom = GEOSGeometry(feat.geom.wkt, srid=feat.geom.srid or 4326)
                    if geom.srid != 4326:
                        geom.transform(4326)
                    geom_type = _classify_geom(geom.geom_type)
                    attrs = {field: _safe_val(feat[field].value) for field in feat.fields}
                    fid = str(feat[name_field].value) if name_field and name_field in feat.fields else ''
                    GISFeature.objects.create(
                        project=project,
                        folder=folder,
                        layer_name=layer_name,
                        geometry_type=geom_type,
                        geometry=geom,
                        feature_id=fid,
                        attributes=attrs,
                        created_by=user,
                    )
                    created += 1
                except Exception as exc:
                    errors.append(str(exc))

    shp_import.status = ShapefileImport.DONE if not errors else ShapefileImport.FAILED
    shp_import.feature_count = created
    shp_import.error = '; '.join(errors[:5]) if errors else ''
    shp_import.save(update_fields=['status', 'feature_count', 'error'])

    return Response({
        'detail': f'Imported {created} feature(s) from Shapefile.',
        'created': created,
        'errors': errors[:10],
        'type': 'vector',
        'import_id': shp_import.id,
    }, status=201)


def _import_geojson_file(folder, uploaded, layer_name, name_field, user):
    """Parse a GeoJSON file and import all features."""
    import json
    from django.contrib.gis.geos import GEOSGeometry
    from rest_framework.response import Response

    try:
        data = json.loads(uploaded.read().decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        return Response({'detail': f'Invalid GeoJSON: {exc}'}, status=400)

    if data.get('type') == 'Feature':
        features = [data]
    elif data.get('type') == 'FeatureCollection':
        features = data.get('features', [])
    else:
        return Response({'detail': 'GeoJSON must be a Feature or FeatureCollection.'}, status=400)

    created = 0
    errors = []
    project = folder.project

    for feat in features:
        try:
            geom = GEOSGeometry(json.dumps(feat['geometry']), srid=4326)
            geom_type = _classify_geom(geom.geom_type)
            attrs = feat.get('properties') or {}
            fid = str(attrs.get(name_field, '')) if name_field else ''
            GISFeature.objects.create(
                project=project,
                folder=folder,
                layer_name=layer_name,
                geometry_type=geom_type,
                geometry=geom,
                feature_id=fid,
                attributes=attrs,
                created_by=user,
            )
            created += 1
        except Exception as exc:
            errors.append(str(exc))

    return Response({
        'detail': f'Imported {created} feature(s) from GeoJSON.',
        'created': created,
        'errors': errors[:10],
        'type': 'vector',
    }, status=201)


def _import_via_gdal(folder, uploaded, layer_name, name_field, user, fmt):
    """Import KML or GeoPackage via GDAL DataSource."""
    import os
    import tempfile
    from django.contrib.gis.gdal import DataSource
    from django.contrib.gis.geos import GEOSGeometry
    from rest_framework.response import Response

    suffix = f'.{fmt}'
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        for chunk in uploaded.chunks():
            tmp.write(chunk)
        tmp_path = tmp.name

    try:
        try:
            ds = DataSource(tmp_path)
        except Exception as exc:
            return Response({'detail': f'Cannot read {fmt.upper()} file: {exc}'}, status=400)

        created = 0
        errors = []
        project = folder.project

        for lyr in ds:
            for feat in lyr:
                try:
                    geom = GEOSGeometry(feat.geom.wkt, srid=feat.geom.srid or 4326)
                    if geom.srid != 4326:
                        geom.transform(4326)
                    geom_type = _classify_geom(geom.geom_type)
                    attrs = {field: _safe_val(feat[field].value) for field in feat.fields}
                    fid = str(feat[name_field].value) if name_field and name_field in feat.fields else ''
                    GISFeature.objects.create(
                        project=project,
                        folder=folder,
                        layer_name=layer_name,
                        geometry_type=geom_type,
                        geometry=geom,
                        feature_id=fid,
                        attributes=attrs,
                        created_by=user,
                    )
                    created += 1
                except Exception as exc:
                    errors.append(str(exc))
    finally:
        os.unlink(tmp_path)

    return Response({
        'detail': f'Imported {created} feature(s) from {fmt.upper()}.',
        'created': created,
        'errors': errors[:10],
        'type': 'vector',
    }, status=201)


def _classify_geom(geom_type: str) -> str:
    """Map GDAL/GEOS geometry type strings to GISFeature.geometry_type choices."""
    gt = geom_type.upper()
    if 'POINT' in gt:
        return GISFeature.POINT
    if 'LINE' in gt or 'STRING' in gt:
        return GISFeature.LINE
    return GISFeature.POLYGON


def _safe_val(v):
    """Convert non-JSON-serialisable attribute values to strings."""
    if isinstance(v, (str, int, float, bool, type(None))):
        return v
    return str(v)


class SurveyAreaViewSet(viewsets.ModelViewSet):
    """
    CRUD for SurveyArea objects.
    Workflow transitions are handled via POST /workflow/steps/area-transition/{pk}/{transition}/
    """
    serializer_class = SurveyAreaSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter]
    filterset_fields = ['project', 'status', 'assigned_to']
    search_fields = ['name', 'area_code', 'description']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            SurveyArea.objects.select_related(
                'project__organisation', 'assigned_to', 'created_by', 'folder'
            ),
            org_field='project__organisation',
        )

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [permissions.IsAuthenticated(), CanEditProject()]

    def perform_create(self, serializer):
        from apps.accounts.models import User
        user = self.request.user
        project = serializer.validated_data.get('project')
        # Only SDO/SURVEYOR/SUPERADMIN can create survey areas
        if user.role not in (User.SDO, User.SURVEYOR, User.SUPERADMIN):
            raise PermissionDenied('Only SDO/Surveyor can create survey areas.')
        if user.role != User.SUPERADMIN and project.organisation != user.organisation:
            raise PermissionDenied('Permission denied.')
        serializer.save(created_by=user)

    def perform_update(self, serializer):
        from apps.accounts.models import User
        area = self.get_object()
        user = self.request.user
        if area.status not in (SurveyArea.DRAFT, SurveyArea.RETURNED):
            raise PermissionDenied('Cannot edit a survey area that has been submitted.')
        serializer.save()

    def perform_destroy(self, instance):
        from apps.accounts.models import User
        user = self.request.user
        if instance.status not in (SurveyArea.DRAFT, SurveyArea.RETURNED):
            raise PermissionDenied('Cannot delete a submitted survey area.')
        instance.delete()


class ProjectLayerFolderViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectLayerFolderSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['project', 'parent', 'folder_type', 'is_final']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            ProjectLayerFolder.objects.select_related('project__organisation', 'parent', 'created_by'),
            org_field='project__organisation',
        )

    def get_permissions(self):
        if self.action in ['list', 'retrieve', 'import_gis_file', 'tree', 'upload_doc', 'files']:
            return [permissions.IsAuthenticated()]
        return [CanEditProject()]

    def perform_create(self, serializer):
        folder = serializer.save(created_by=self.request.user)
        # Auto-create Doc and Shapefile subfolders for every user-created folder
        # (but not for DOC/SHAPEFILE folders themselves to avoid recursion)
        if folder.folder_type not in (ProjectLayerFolder.DOC, ProjectLayerFolder.SHAPEFILE):
            _add_doc_shapefile_subfolders(folder, self.request.user)

    @action(detail=True, methods=['post'], url_path='upload-doc',
            permission_classes=[permissions.IsAuthenticated])
    def upload_doc(self, request, pk=None):
        """
        POST /api/projects/folders/{id}/upload-doc/
        Upload any document file to this folder (folder_type must be DOC).
        Body: multipart/form-data with 'file' and optional 'title', 'category'
        """
        from apps.documents.models import Document
        folder = self.get_object()
        uploaded = request.FILES.get('file')
        if not uploaded:
            return Response({'detail': 'No file provided.'}, status=400)
        title = (request.data.get('title') or uploaded.name).strip()
        category = request.data.get('category', Document.OTHER)
        doc = Document.objects.create(
            project=folder.project,
            folder=folder,
            title=title,
            category=category,
            file=uploaded,
            file_size=uploaded.size,
            mime_type=getattr(uploaded, 'content_type', ''),
            uploaded_by=request.user,
        )
        return Response({'detail': 'Document uploaded.', 'id': doc.id}, status=201)

    @action(detail=True, methods=['get'])
    def tree(self, request, pk=None):
        """Return nested folder tree rooted at this folder."""
        folder = self.get_object()
        return Response(ProjectLayerFolderSerializer(folder).data)

    @action(detail=True, methods=['get'], url_path='files')
    def files(self, request, pk=None):
        """
        GET /api/projects/folders/{id}/files/
        Returns lists of documents and GeoTiff layers in this folder.
        Used by the QGIS plugin for duplicate detection before upload.
        """
        from apps.documents.models import Document
        from apps.documents.serializers import DocumentSerializer
        from .serializers import GeoTiffLayerSerializer

        folder = self.get_object()
        docs = Document.objects.filter(folder=folder).values(
            'id', 'title', 'file', 'mime_type', 'file_size', 'uploaded_at'
        )
        geotiffs = GeoTiffLayer.objects.filter(folder=folder).values(
            'id', 'name', 'file', 'status', 'created_at'
        )
        return Response({
            'folder_id': folder.id,
            'folder_name': folder.name,
            'documents': list(docs),
            'geotiffs': list(geotiffs),
        })

    @action(detail=True, methods=['post'], url_path='import-gis-file',
            permission_classes=[permissions.IsAuthenticated])
    def import_gis_file(self, request, pk=None):
        """
        POST /api/projects/folders/{id}/import-gis-file/
        Supported formats:
          .zip       — Shapefile bundle (must contain .shp + .dbf + .shx)
          .geojson / .json — GeoJSON FeatureCollection or Feature
          .kml       — KML (via GDAL)
          .gpkg      — GeoPackage (via GDAL)
          .tif/.tiff — GeoTiff (creates GeoTiffLayer, queues COG conversion)
        Body params:
          layer_name  — display name for created features (default: filename stem)
          name_field  — attribute to use as feature_id label (optional)
        """
        import os
        folder = self.get_object()
        uploaded = request.FILES.get('file')
        if not uploaded:
            return Response({'detail': 'No file uploaded.'}, status=400)

        fname = uploaded.name
        ext = os.path.splitext(fname)[1].lower()
        layer_name = (request.data.get('layer_name') or os.path.splitext(fname)[0]).strip()
        name_field = request.data.get('name_field', '').strip()

        if ext in ('.tif', '.tiff'):
            return _import_geotiff(folder, uploaded, layer_name, request.user)
        if ext == '.zip':
            return _import_shapefile_zip(folder, uploaded, layer_name, name_field, request.user)
        if ext in ('.geojson', '.json'):
            return _import_geojson_file(folder, uploaded, layer_name, name_field, request.user)
        if ext in ('.kml', '.gpkg'):
            return _import_via_gdal(folder, uploaded, layer_name, name_field, request.user, ext.lstrip('.'))
        return Response(
            {'detail': f'Unsupported format "{ext}". Accepted: .zip, .geojson, .json, .kml, .gpkg, .tif, .tiff'},
            status=400
        )


class ProjectShareViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectShareSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['project', 'granted_to']
    http_method_names = ['get', 'post', 'delete', 'head', 'options']

    def get_queryset(self):
        user = self.request.user
        from apps.accounts.models import User
        if user.role == User.SUPERADMIN:
            return ProjectShare.objects.select_related('project__organisation', 'granted_to', 'granted_by').all()
        return ProjectShare.objects.select_related('project__organisation', 'granted_to', 'granted_by').filter(
            project__organisation=user.organisation
        )

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [CanEditProject()]

    def perform_create(self, serializer):
        serializer.save(granted_by=self.request.user)


def _export_features(qs, project, fmt: str):
    """Export a queryset of GISFeatures in the requested format."""
    import json
    import tempfile
    import os
    from django.http import HttpResponse, FileResponse
    from django.contrib.gis.serializers.geojson import Serializer as GeoJSONSerializer

    features = list(qs.select_related('created_by'))

    if fmt == 'geojson':
        fc = {
            'type': 'FeatureCollection',
            'features': [
                {
                    'type': 'Feature',
                    'geometry': json.loads(f.geometry.geojson),
                    'properties': {
                        'id': f.id,
                        'layer_name': f.layer_name,
                        'geometry_type': f.geometry_type,
                        'feature_id': f.feature_id,
                        **f.attributes,
                        'created_by': str(f.created_by),
                        'created_at': f.created_at.isoformat(),
                    },
                }
                for f in features
            ],
        }
        resp = HttpResponse(json.dumps(fc, indent=2), content_type='application/geo+json')
        resp['Content-Disposition'] = f'attachment; filename="{project.project_number}.geojson"'
        return resp

    if fmt == 'csv':
        import csv
        import io
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(['id', 'layer_name', 'geometry_type', 'feature_id', 'longitude', 'latitude', 'created_at'])
        for f in features:
            centroid = f.geometry.centroid
            writer.writerow([f.id, f.layer_name, f.geometry_type, f.feature_id, centroid.x, centroid.y, f.created_at.isoformat()])
        resp = HttpResponse(buf.getvalue(), content_type='text/csv')
        resp['Content-Disposition'] = f'attachment; filename="{project.project_number}.csv"'
        return resp

    if fmt in ('shapefile', 'gpkg', 'kml', 'geojson2'):
        try:
            import fiona
            import fiona.crs
            from fiona.transform import transform_geom
        except ImportError:
            from django.http import HttpResponse
            return HttpResponse('fiona not available', status=500)

        driver_map = {
            'shapefile': ('ESRI Shapefile', '.shp', '.zip'),
            'gpkg': ('GPKG', '.gpkg', '.gpkg'),
            'kml': ('KML', '.kml', '.kml'),
        }
        driver, ext, archive_ext = driver_map.get(fmt, ('ESRI Shapefile', '.shp', '.zip'))

        import tempfile, os, zipfile, io

        with tempfile.TemporaryDirectory() as tmpdir:
            out_path = os.path.join(tmpdir, f"{project.project_number}{ext}")

            schema = {
                'geometry': 'Unknown',
                'properties': {
                    'id': 'int',
                    'layer_name': 'str',
                    'feature_id': 'str',
                    'created_at': 'str',
                },
            }

            with fiona.open(out_path, 'w', driver=driver, schema=schema,
                            crs=fiona.crs.from_epsg(4326)) as dst:
                for f in features:
                    geom = json.loads(f.geometry.geojson)
                    dst.write({
                        'geometry': geom,
                        'properties': {
                            'id': f.id,
                            'layer_name': f.layer_name,
                            'feature_id': f.feature_id or '',
                            'created_at': f.created_at.isoformat(),
                        },
                    })

            if fmt == 'shapefile':
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
                    for fn in os.listdir(tmpdir):
                        zf.write(os.path.join(tmpdir, fn), fn)
                buf.seek(0)
                resp = HttpResponse(buf.read(), content_type='application/zip')
                resp['Content-Disposition'] = f'attachment; filename="{project.project_number}.zip"'
                return resp
            else:
                with open(out_path, 'rb') as fh:
                    content_type = 'application/octet-stream'
                    resp = HttpResponse(fh.read(), content_type=content_type)
                    resp['Content-Disposition'] = f'attachment; filename="{project.project_number}{archive_ext}"'
                    return resp

    from django.http import HttpResponse
    return HttpResponse('Unsupported format', status=400)


class GeoTiffLayerViewSet(viewsets.ModelViewSet):
    serializer_class = GeoTiffLayerSerializer
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ['project', 'folder', 'status']
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    def get_queryset(self):
        return org_queryset_filter(
            self.request.user,
            GeoTiffLayer.objects.select_related('project__organisation', 'folder', 'created_by'),
            org_field='project__organisation',
        )

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [CanEditProject()]

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        ctx['request'] = self.request
        return ctx

    def perform_create(self, serializer):
        from .tasks import convert_geotiff_to_cog
        layer = serializer.save(created_by=self.request.user)
        convert_geotiff_to_cog.delay(layer.id)


class TopologyCheckView(APIView):
    """GET /api/projects/topology/ — check DefenceParcel geometries for errors."""
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        from django.db import connection

        # Org-filtered base queryset
        from apps.accounts.permissions import org_queryset_filter
        base_qs = org_queryset_filter(
            request.user,
            DefenceParcel.objects.select_related('state', 'district'),
        )

        # 1. Self-intersecting / invalid geometries
        invalid = base_qs.extra(where=['NOT ST_IsValid("survey_projects_defenceparcel"."geometry")'])
        invalid_list = [
            {'type': 'INVALID_GEOMETRY',
             'parcel_a': {'id': p.id, 'parcel_id': p.parcel_id, 'name': p.name}}
            for p in invalid
        ]

        # 2. Overlapping parcel pairs
        id_list = list(base_qs.values_list('id', flat=True))
        overlaps = []
        if len(id_list) >= 2:
            placeholders = ','.join(['%s'] * len(id_list))
            with connection.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT a.id, a.parcel_id, a.name,
                           b.id, b.parcel_id, b.name,
                           ST_AsGeoJSON(ST_Centroid(ST_Intersection(a.geometry, b.geometry)))
                    FROM survey_projects_defenceparcel a
                    JOIN survey_projects_defenceparcel b ON a.id < b.id
                    WHERE a.id IN ({placeholders})
                      AND b.id IN ({placeholders})
                      AND ST_Intersects(a.geometry, b.geometry)
                      AND NOT ST_Touches(a.geometry, b.geometry)
                    LIMIT 200
                    """,
                    id_list + id_list,
                )
                for row in cur.fetchall():
                    overlaps.append({
                        'type': 'OVERLAP',
                        'parcel_a': {'id': row[0], 'parcel_id': row[1], 'name': row[2]},
                        'parcel_b': {'id': row[3], 'parcel_id': row[4], 'name': row[5]},
                        'centroid': json.loads(row[6]) if row[6] else None,
                    })

        issues = invalid_list + overlaps
        return Response({'issues': issues, 'total': len(issues)})


class BufferAnalysisView(APIView):
    """POST /api/projects/buffer/
    Modes:
      - Point buffer (default): requires lng, lat
      - Feature buffer: requires feature_ids (list of GISFeature IDs) or layer_name + project_id
    Common params: distances (list), unit (meters|kilometers), dissolve (bool)
    """
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        from django.contrib.gis.geos import Point, GEOSGeometry
        from django.contrib.gis.measure import D
        from django.db import connection

        raw_distances = request.data.get('distances', [100])
        unit = request.data.get('unit', 'meters')
        dissolve = bool(request.data.get('dissolve', False))

        # ── Determine source geometry ──────────────────────────────────────────
        feature_ids = request.data.get('feature_ids')
        layer_name  = request.data.get('layer_name')
        project_id  = request.data.get('project_id')

        if feature_ids or layer_name:
            # Feature-based buffer
            if feature_ids:
                feats = GISFeature.objects.filter(id__in=feature_ids, is_deleted=False)
            else:
                feats = GISFeature.objects.filter(
                    project_id=project_id, layer_name=layer_name, is_deleted=False
                )
            if not feats.exists():
                return Response({'detail': 'No features found.'}, status=status.HTTP_400_BAD_REQUEST)

            # Combine all feature geometries into a UNION
            from django.contrib.gis.db.models import Union as GeoUnion
            combined = feats.aggregate(union=GeoUnion('geometry'))['union']
            if not combined:
                return Response({'detail': 'Features have no geometry.'}, status=status.HTTP_400_BAD_REQUEST)

            source_wkt = combined.wkt
            # Compute centroid for display
            centroid = combined.centroid
            lng, lat = centroid.x, centroid.y
        else:
            # Point-based buffer: use exact click coordinates
            try:
                lng = float(request.data['lng'])
                lat = float(request.data['lat'])
            except (KeyError, TypeError, ValueError):
                return Response({'detail': 'Provide lng/lat or feature_ids or layer_name.'}, status=status.HTTP_400_BAD_REQUEST)

            source_wkt = f'SRID=4326;POINT({lng} {lat})'

        if not isinstance(raw_distances, list) or not raw_distances:
            return Response({'detail': 'distances must be a non-empty list.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            distances = sorted(float(d) for d in raw_distances)
        except (TypeError, ValueError):
            return Response({'detail': 'Each distance must be a number.'}, status=status.HTTP_400_BAD_REQUEST)

        ref_point = Point(lng, lat, srid=4326)
        multiplier = 1000 if unit == 'kilometers' else 1
        results = []

        for dist in distances:
            dist_m = dist * multiplier

            # Build PostGIS buffer from source geometry
            with connection.cursor() as cur:
                cur.execute(
                    "SELECT ST_AsGeoJSON(ST_Buffer(ST_GeogFromText(%s)::geography, %s)::geometry)",
                    [source_wkt, dist_m],
                )
                buffer_geojson = json.loads(cur.fetchone()[0])

            # Find parcels intersecting this buffer
            with connection.cursor() as cur:
                cur.execute(
                    "SELECT ST_AsText(ST_Buffer(ST_GeogFromText(%s)::geography, %s)::geometry)",
                    [source_wkt, dist_m],
                )
                buffer_wkt = cur.fetchone()[0]

            buffer_geom = GEOSGeometry(buffer_wkt, srid=4326)
            parcels = DefenceParcel.objects.filter(
                geometry__intersects=buffer_geom
            ).annotate(
                distance=Distance('geometry', ref_point)
            ).select_related('state', 'district', 'organisation')

            # Find survey area features (GISFeature) within this buffer ring
            nearby_features = (
                GISFeature.objects
                .filter(geometry__intersects=buffer_geom, is_deleted=False)
                .select_related(
                    'project', 'project__organisation',
                    'folder',
                )
            )

            # Group nearby features by survey area (via folder → survey_area_link)
            from collections import defaultdict
            area_map = defaultdict(lambda: {
                'area_id': None, 'area_name': None, 'area_code': None,
                'status': None, 'status_display': None,
                'project_id': None, 'project_name': None,
                'organisation': None,
                'feature_count': 0, 'layers': set(),
            })

            for feat in nearby_features:
                # Resolve survey area through folder chain
                folder = feat.folder
                survey_area = None
                if folder:
                    try:
                        survey_area = folder.survey_area_link
                    except Exception:
                        pass
                    if not survey_area:
                        # walk up to find a folder linked to a survey area
                        parent = folder.parent if folder else None
                        while parent and not survey_area:
                            try:
                                survey_area = parent.survey_area_link
                            except Exception:
                                pass
                            parent = parent.parent if parent else None

                key = survey_area.id if survey_area else f'project_{feat.project_id}'
                entry = area_map[key]
                if survey_area and not entry['area_id']:
                    entry.update({
                        'area_id': survey_area.id,
                        'area_name': survey_area.name,
                        'area_code': survey_area.area_code,
                        'status': survey_area.status,
                        'status_display': survey_area.get_status_display(),
                    })
                if not entry['project_id']:
                    entry.update({
                        'project_id': feat.project_id,
                        'project_name': str(feat.project),
                        'organisation': feat.project.organisation.name if feat.project.organisation_id else '',
                    })
                entry['feature_count'] += 1
                entry['layers'].add(feat.layer_name)

            survey_areas_data = []
            for entry in area_map.values():
                survey_areas_data.append({
                    **{k: v for k, v in entry.items() if k != 'layers'},
                    'layers': sorted(entry['layers']),
                })
            survey_areas_data.sort(key=lambda x: x['feature_count'], reverse=True)

            results.append({
                'distance': dist,
                'unit': unit,
                'distance_m': dist_m,
                'buffer_geojson': buffer_geojson,
                'parcels': BufferParcelSerializer(parcels, many=True).data,
                'feature_count': parcels.count(),
                'survey_areas': survey_areas_data,
                'survey_area_count': len(survey_areas_data),
                'dissolve': dissolve,
            })

        return Response({
            'center_lng': lng,
            'center_lat': lat,
            'rings': results,
        })


# ── Feature Attachments ───────────────────────────────────────────────────────

class FeatureAttachmentViewSet(viewsets.ModelViewSet):
    serializer_class = FeatureAttachmentSerializer
    http_method_names = ['get', 'post', 'delete', 'head', 'options']

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [CanEditProject()]

    def get_queryset(self):
        feature_id = self.kwargs.get('feature_pk') or self.request.query_params.get('feature')
        qs = FeatureAttachment.objects.select_related('uploaded_by', 'feature__project')
        if feature_id:
            qs = qs.filter(feature_id=feature_id)
        return qs

    def perform_create(self, request_file=None, **kwargs):
        pass  # handled in create()

    def create(self, request, *args, **kwargs):
        file_obj = request.FILES.get('file')
        if not file_obj:
            return Response({'detail': 'No file uploaded.'}, status=400)

        feature_id = request.data.get('feature') or self.kwargs.get('feature_pk')
        try:
            feature = GISFeature.objects.get(pk=feature_id)
        except GISFeature.DoesNotExist:
            return Response({'detail': 'Feature not found.'}, status=404)

        # Determine file type from extension
        ext = file_obj.name.rsplit('.', 1)[-1].lower() if '.' in file_obj.name else ''
        if ext in ('jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'bmp'):
            file_type = 'image'
        elif ext == 'pdf':
            file_type = 'pdf'
        else:
            file_type = 'doc'

        attachment = FeatureAttachment.objects.create(
            feature=feature,
            file=file_obj,
            original_filename=file_obj.name,
            file_size=file_obj.size,
            file_type=file_type,
            caption=request.data.get('caption', ''),
            uploaded_by=request.user,
        )
        return Response(
            FeatureAttachmentSerializer(attachment, context={'request': request}).data,
            status=201,
        )


# ── Bulk CSV Import ───────────────────────────────────────────────────────────

class CSVImportView(APIView):
    permission_classes = [CanEditProject]

    def post(self, request, pk=None):
        import csv, io
        from django.contrib.gis.geos import Point as GEOSPoint, GEOSGeometry

        try:
            project = SurveyProject.objects.get(pk=pk)
        except SurveyProject.DoesNotExist:
            return Response({'detail': 'Project not found.'}, status=404)

        file_obj = request.FILES.get('file')
        if not file_obj:
            return Response({'detail': 'No CSV file uploaded.'}, status=400)

        layer_name = request.data.get('layer_name', 'imported_layer')
        lat_col = request.data.get('lat_col', 'latitude')
        lon_col = request.data.get('lon_col', 'longitude')
        wkt_col = request.data.get('wkt_col', '')

        try:
            text = file_obj.read().decode('utf-8-sig')
            reader = csv.DictReader(io.StringIO(text))
            rows = list(reader)
        except Exception as e:
            return Response({'detail': f'Could not parse CSV: {e}'}, status=400)

        imported = 0
        errors = []

        for i, row in enumerate(rows, 1):
            try:
                if wkt_col and wkt_col in row and row[wkt_col].strip():
                    geom = GEOSGeometry(row[wkt_col].strip(), srid=4326)
                    geom_type = geom.geom_type.upper()
                elif lat_col in row and lon_col in row:
                    lat = float(row[lat_col])
                    lon = float(row[lon_col])
                    geom = GEOSPoint(lon, lat, srid=4326)
                    geom_type = 'POINT'
                else:
                    errors.append(f'Row {i}: missing geometry columns')
                    continue

                attrs = {k: v for k, v in row.items()
                         if k not in (lat_col, lon_col, wkt_col) and v}

                GISFeature.objects.create(
                    project=project,
                    layer_name=layer_name,
                    geometry_type=geom_type if geom_type in ('POINT', 'LINE', 'POLYGON') else 'POINT',
                    geometry=geom,
                    attributes=attrs,
                    created_by=request.user,
                )
                imported += 1
            except Exception as e:
                errors.append(f'Row {i}: {e}')

        # Log export/import action
        try:
            from apps.accounts.models import ExportAuditLog
            ExportAuditLog.objects.create(
                user=request.user, export_type='csv_import',
                project=project, row_count=imported,
            )
        except Exception:
            pass

        return Response({'imported': imported, 'total': len(rows), 'errors': errors[:20]})


# ── Encroachment Detection ────────────────────────────────────────────────────

class EncroachmentView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk=None):
        from django.db import connection
        try:
            project = SurveyProject.objects.get(pk=pk)
        except SurveyProject.DoesNotExist:
            return Response({'detail': 'Project not found.'}, status=404)

        features = GISFeature.objects.filter(project=project, is_deleted=False).exclude(
            geometry_type='POINT'
        )

        encroachments = []
        for feat in features:
            from apps.gis_layers.models import RevenueMap
            overlapping = RevenueMap.objects.filter(
                geometry__intersects=feat.geometry
            ).exclude(geometry__equals=feat.geometry)[:5]
            for rm in overlapping:
                with connection.cursor() as cur:
                    cur.execute(
                        'SELECT ST_Area(ST_Intersection(%s::geometry, %s::geometry)::geography)',
                        [feat.geometry.wkt, rm.geometry.wkt],
                    )
                    area_m2 = cur.fetchone()[0] or 0
                encroachments.append({
                    'feature_id': feat.id,
                    'feature_label': feat.feature_id or str(feat.id),
                    'layer_name': feat.layer_name,
                    'revenue_map_id': rm.id,
                    'survey_number': rm.survey_number,
                    'overlap_area_m2': round(area_m2, 2),
                    'overlap_area_ha': round(area_m2 / 10000, 4),
                })

        return Response({
            'project_id': project.id,
            'project_number': project.project_number,
            'encroachment_count': len(encroachments),
            'encroachments': encroachments,
        })


# ── Feature Merge ─────────────────────────────────────────────────────────────

class FeatureMergeView(APIView):
    permission_classes = [CanEditProject]

    def post(self, request):
        from django.contrib.gis.geos import GEOSGeometry
        feature_ids = request.data.get('feature_ids', [])
        layer_name = request.data.get('layer_name', '')

        if len(feature_ids) < 2:
            return Response({'detail': 'Provide at least 2 feature_ids.'}, status=400)

        features = GISFeature.objects.filter(pk__in=feature_ids, is_deleted=False)
        if features.count() < 2:
            return Response({'detail': 'Could not find the requested features.'}, status=404)

        # Ensure all belong to the same project
        project_ids = set(features.values_list('project_id', flat=True))
        if len(project_ids) > 1:
            return Response({'detail': 'All features must belong to the same project.'}, status=400)

        from django.db import connection
        wkt_list = [f.geometry.wkt for f in features]
        placeholders = ', '.join(['%s::geometry'] * len(wkt_list))
        with connection.cursor() as cur:
            cur.execute(f'SELECT ST_AsText(ST_Union(ARRAY[{placeholders}]))', wkt_list)
            merged_wkt = cur.fetchone()[0]

        merged_geom = GEOSGeometry(merged_wkt, srid=4326)
        first = features.first()
        new_feature = GISFeature.objects.create(
            project=first.project,
            folder=first.folder,
            layer_name=layer_name or first.layer_name,
            geometry_type=first.geometry_type,
            geometry=merged_geom,
            attributes={},
            created_by=request.user,
        )
        features.update(is_deleted=True)

        return Response(GISFeatureSerializer(new_feature).data, status=201)


# ── Feature Split ─────────────────────────────────────────────────────────────

class FeatureSplitView(APIView):
    permission_classes = [CanEditProject]

    def post(self, request, pk=None):
        from django.contrib.gis.geos import GEOSGeometry
        from django.db import connection

        try:
            feature = GISFeature.objects.get(pk=pk)
        except GISFeature.DoesNotExist:
            return Response({'detail': 'Feature not found.'}, status=404)

        split_line = request.data.get('split_line')
        if not split_line:
            return Response({'detail': 'split_line GeoJSON required.'}, status=400)

        try:
            import json
            line_geom = GEOSGeometry(json.dumps(split_line), srid=4326)
        except Exception as e:
            return Response({'detail': f'Invalid split_line: {e}'}, status=400)

        with connection.cursor() as cur:
            cur.execute(
                '''
                SELECT ST_AsText((ST_Dump(
                    ST_Split(
                        ST_Snap(%s::geometry, %s::geometry, 0.0000001),
                        %s::geometry
                    )
                )).geom)
                ''',
                [feature.geometry.wkt, line_geom.wkt, line_geom.wkt],
            )
            parts = [row[0] for row in cur.fetchall()]

        if len(parts) < 2:
            return Response({'detail': 'Split produced fewer than 2 parts. Check split line intersects the feature.'}, status=400)

        new_features = []
        for part_wkt in parts:
            part_geom = GEOSGeometry(part_wkt, srid=4326)
            nf = GISFeature.objects.create(
                project=feature.project,
                folder=feature.folder,
                layer_name=feature.layer_name,
                geometry_type=feature.geometry_type,
                geometry=part_geom,
                attributes=dict(feature.attributes),
                created_by=request.user,
            )
            new_features.append(nf)

        feature.is_deleted = True
        feature.save(update_fields=['is_deleted'])

        return Response(GISFeatureSerializer(new_features, many=True).data, status=201)


# ── Project Milestones (Gantt) ────────────────────────────────────────────────

class ProjectMilestoneViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectMilestoneSerializer

    def get_permissions(self):
        if self.action in ['list', 'retrieve']:
            return [permissions.IsAuthenticated()]
        return [CanEditProject()]

    def get_queryset(self):
        project_id = self.kwargs.get('project_pk') or self.request.query_params.get('project')
        qs = ProjectMilestone.objects.select_related('assignee', 'created_by', 'project')
        if project_id:
            qs = qs.filter(project_id=project_id)
        return qs

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)


# ── QGIS Upload Log ───────────────────────────────────────────────────────────

class QGISUploadLogViewSet(viewsets.ModelViewSet):
    """
    GET  /api/projects/qgis-uploads/                — list (filterable by project/status)
    POST /api/projects/qgis-uploads/                — QGIS plugin writes upload records
    GET  /api/projects/qgis-uploads/{id}/           — detail
    POST /api/projects/qgis-uploads/{id}/retry/     — re-queue a FAILED upload
    """
    from .serializers import QGISUploadLogSerializer
    serializer_class = QGISUploadLogSerializer
    filter_backends  = [DjangoFilterBackend]
    filterset_fields = ['project', 'status', 'algorithm_id']
    http_method_names = ['get', 'post', 'head', 'options']

    def get_queryset(self):
        from .models import QGISUploadLog
        user = self.request.user
        from apps.accounts.models import User as AccountUser
        qs = QGISUploadLog.objects.select_related(
            'project', 'folder', 'uploaded_by'
        )
        if user.role == AccountUser.SUPERADMIN:
            return qs
        return qs.filter(project__organisation=user.organisation)

    def get_permissions(self):
        return [permissions.IsAuthenticated()]

    def perform_create(self, serializer):
        log = serializer.save(uploaded_by=self.request.user)
        if log.status == 'SUCCESS':
            self._notify_project_team(log, self.request.user)

    def _notify_project_team(self, log, uploader):
        """Send an in-app notification to project admins when a file is uploaded."""
        try:
            from apps.workflow.models import Notification
            from apps.accounts.models import User as AccountUser
            recipients = AccountUser.objects.filter(
                organisation=log.project.organisation,
                role__in=[
                    AccountUser.SUPERADMIN,
                    AccountUser.DEO_ADMIN,
                    AccountUser.CEO_ADMIN,
                    AccountUser.ADEO_ADMIN,
                ],
                is_active=True,
            ).exclude(pk=uploader.pk)
            folder_label = log.folder.name if log.folder else (log.module_name or log.folder_name or 'Unknown')
            notifs = [
                Notification(
                    user=u,
                    project=log.project,
                    title='New QGIS Upload',
                    message=(
                        f'{uploader.get_full_name() or uploader.username} uploaded '
                        f'"{log.filename}" to {log.project.project_number} / {folder_label}.'
                    ),
                )
                for u in recipients
            ]
            if notifs:
                Notification.objects.bulk_create(notifs)
        except Exception:
            pass  # never fail the upload log write because of notification issues

    @action(detail=True, methods=['post'], url_path='retry')
    def retry(self, request, pk=None):
        """
        Mark a FAILED log entry as pending-retry and send a workflow notification
        so the user knows to re-run the QGIS upload.  The actual re-upload must
        originate from the QGIS plugin — the server cannot pull files from the
        client machine, so we reset the record and notify the uploader.
        """
        from .models import QGISUploadLog
        log = self.get_object()

        if log.status != QGISUploadLog.FAILED:
            return Response(
                {'detail': 'Only FAILED uploads can be retried.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Reset to SKIPPED so it no longer shows as failed; the plugin will
        # POST a fresh record on the next successful upload.
        log.status = QGISUploadLog.SKIPPED
        log.error_message = f'[Retry requested by {request.user.username}] {log.error_message or ""}'.strip()
        log.save(update_fields=['status', 'error_message'])

        # Notify the original uploader (if different from requester)
        if log.uploaded_by and log.uploaded_by != request.user:
            from apps.workflow.models import Notification
            Notification.objects.create(
                user=log.uploaded_by,
                project=log.project,
                title='QGIS Upload Retry Requested',
                message=(
                    f'{request.user.get_full_name() or request.user.username} has requested '
                    f'a retry for "{log.filename}" '
                    f'(project {log.project.project_number}). '
                    'Please re-upload the file from QGIS.'
                ),
            )

        from .serializers import QGISUploadLogSerializer
        return Response(QGISUploadLogSerializer(log).data)


# ── Temporary Layer Upload ─────────────────────────────────────────────────────

def _parse_temp_layer_file(file_obj):
    """Parse KML/KMZ/GeoJSON/Shapefile-ZIP into a GeoJSON FeatureCollection dict.
    Returns (geojson_dict, feature_count, file_format_str).
    """
    import os, tempfile, zipfile, json, shutil
    from django.contrib.gis.gdal import DataSource

    name = file_obj.name.lower()
    ext = name.rsplit('.', 1)[-1] if '.' in name else ''

    # Write uploaded file to a temp path so GDAL can open it
    tmp_dir = tempfile.mkdtemp(prefix='tmplayer_')
    try:
        if ext == 'kmz':
            # KMZ = zipped KML
            kmz_path = os.path.join(tmp_dir, 'upload.kmz')
            with open(kmz_path, 'wb') as f:
                for chunk in file_obj.chunks():
                    f.write(chunk)
            with zipfile.ZipFile(kmz_path) as zf:
                kml_names = [n for n in zf.namelist() if n.lower().endswith('.kml')]
                if not kml_names:
                    raise ValueError('No .kml file found inside KMZ archive.')
                zf.extract(kml_names[0], tmp_dir)
                src_path = os.path.join(tmp_dir, kml_names[0])
            file_format = TemporaryLayer.KMZ

        elif ext == 'kml':
            src_path = os.path.join(tmp_dir, 'upload.kml')
            with open(src_path, 'wb') as f:
                for chunk in file_obj.chunks():
                    f.write(chunk)
            file_format = TemporaryLayer.KML

        elif ext == 'geojson' or ext == 'json':
            src_path = os.path.join(tmp_dir, 'upload.geojson')
            with open(src_path, 'wb') as f:
                for chunk in file_obj.chunks():
                    f.write(chunk)
            file_format = TemporaryLayer.GEOJSON

        elif ext == 'zip':
            zip_path = os.path.join(tmp_dir, 'upload.zip')
            with open(zip_path, 'wb') as f:
                for chunk in file_obj.chunks():
                    f.write(chunk)
            shp_dir = os.path.join(tmp_dir, 'shp')
            os.makedirs(shp_dir)
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(shp_dir)
            shp_files = []
            for root, dirs, files in os.walk(shp_dir):
                for fn in files:
                    if fn.lower().endswith('.shp'):
                        shp_files.append(os.path.join(root, fn))
            if not shp_files:
                raise ValueError('No .shp file found inside ZIP archive.')
            src_path = shp_files[0]
            file_format = TemporaryLayer.SHAPEFILE
        else:
            raise ValueError(f'Unsupported file type: .{ext}')

        # Use GeoDjango GDAL DataSource to read and convert to GeoJSON
        ds = DataSource(src_path)
        features = []
        for layer in ds:
            for feat in layer:
                try:
                    geom = feat.geom.transform(4326, clone=True)
                    geom_json = json.loads(geom.geojson)
                except Exception:
                    geom_json = None

                props = {}
                for field_name in feat.fields:
                    try:
                        val = feat[field_name].value
                        if isinstance(val, bytes):
                            val = val.decode('utf-8', errors='replace')
                        props[field_name] = val
                    except Exception:
                        props[field_name] = None

                if geom_json:
                    features.append({
                        'type': 'Feature',
                        'geometry': geom_json,
                        'properties': props,
                    })

        geojson = {
            'type': 'FeatureCollection',
            'features': features,
        }
        return geojson, len(features), file_format

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


class TemporaryLayerViewSet(viewsets.ModelViewSet):
    """CRUD for user's own temporary upload layers."""
    from .serializers import TemporaryLayerSerializer as _TLSer
    serializer_class   = _TLSer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        from .models import TemporaryLayer
        return TemporaryLayer.objects.filter(uploaded_by=self.request.user)

    def create(self, request, *args, **kwargs):
        from .models import TemporaryLayer
        from .serializers import TemporaryLayerSerializer
        from rest_framework.exceptions import ValidationError as DRFValidationError

        file_obj = request.FILES.get('file')
        if not file_obj:
            return Response({'detail': 'No file uploaded.'}, status=status.HTTP_400_BAD_REQUEST)

        name = request.data.get('name', '').strip()
        if not name:
            return Response({'detail': 'Layer name is required.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            geojson, feature_count, file_format = _parse_temp_layer_file(file_obj)
        except ValueError as e:
            return Response({'detail': str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            return Response({'detail': f'Failed to parse file: {e}'}, status=status.HTTP_400_BAD_REQUEST)

        if feature_count == 0:
            return Response({'detail': 'No valid features found in the uploaded file.'}, status=status.HTTP_400_BAD_REQUEST)

        # Reset file pointer and save again for the FileField
        file_obj.seek(0)
        layer = TemporaryLayer(
            name=name,
            purpose=request.data.get('purpose', ''),
            description=request.data.get('description', ''),
            file_format=file_format,
            file=file_obj,
            geojson=geojson,
            feature_count=feature_count,
            uploaded_by=request.user,
        )
        layer.save()
        serializer = TemporaryLayerSerializer(layer)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    http_method_names = ['get', 'post', 'delete', 'head', 'options']
