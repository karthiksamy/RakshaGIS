import django
import os
import sys

# Setup django environment
sys.path.append('/app')
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.development')
django.setup()

from apps.survey_projects.models import GeoTiffLayer
from apps.ai_assistant.models import BoundaryExtractionJob
from apps.ai_assistant.tasks import extract_polygons_classical, extract_polygons_ai_pipeline
from django.contrib.auth import get_user_model

def main():
    print("Starting pipeline checks...")
    layer = GeoTiffLayer.objects.first()
    if not layer:
        print("Error: No GeoTiffLayer found in database.")
        sys.exit(1)
    
    project = layer.project
    print(f"Using layer: ID={layer.id}, Name={layer.name}, Project={project.name}")
    
    # Create classical job
    classical_job = BoundaryExtractionJob.objects.create(
        source_geotiff=layer,
        project=project,
        vision_model='classical',
        status=BoundaryExtractionJob.PENDING,
        raw_response='{"min_area_m2": 100.0, "edge_sensitivity": 0.3, "dilation_px": 3, "simplify_tolerance": 0.00005}'
    )
    print(f"Created classical job: ID={classical_job.id}")
    
    try:
        extract_polygons_classical(classical_job.id)
        classical_job.refresh_from_db()
        print(f"Classical pipeline status: {classical_job.status}")
        if classical_job.status == 'FAILED':
            print(f"Classical pipeline error/raw_response: {classical_job.raw_response}")
    except Exception as e:
        print(f"Classical pipeline crashed with exception: {e}")
        import traceback
        traceback.print_exc()

    # Create AI pipeline job
    ai_job = BoundaryExtractionJob.objects.create(
        source_geotiff=layer,
        project=project,
        vision_model='llava:7b',
        status=BoundaryExtractionJob.PENDING,
        raw_response='{"min_area_m2": 100.0, "edge_sensitivity": 0.3, "dilation_px": 3, "simplify_tolerance": 0.00005}'
    )
    print(f"Created AI job: ID={ai_job.id}")

    try:
        extract_polygons_ai_pipeline(ai_job.id)
        ai_job.refresh_from_db()
        print(f"AI pipeline status: {ai_job.status}")
        if ai_job.status == 'FAILED':
            print(f"AI pipeline error/raw_response: {ai_job.raw_response}")
    except Exception as e:
        print(f"AI pipeline crashed with exception: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    main()
