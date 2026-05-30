import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ai_assistant', '0005_aitask_model_pull'),
        ('documents', '0001_initial'),
        ('survey_projects', '0016_survey_area_access_request'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # Add new task type choices (no schema change needed — CharField)
        migrations.AlterField(
            model_name='aitask',
            name='task_type',
            field=models.CharField(
                choices=[
                    ('REPORT_GENERATION',  'Report Generation'),
                    ('PDF_EXTRACTION',     'PDF Text Extraction & Summary'),
                    ('ATTRIBUTE_VALIDATION', 'Attribute Validation'),
                    ('GIS_INDEXING',       'GIS File Indexing'),
                    ('MODEL_PULL',         'Model Pull / Download'),
                    ('DOCUMENT_EMBEDDING', 'Document Embedding (RAG)'),
                    ('BOUNDARY_EXTRACTION','Boundary Extraction from Scanned Map'),
                    ('TRAINING_EXPORT',    'Training Dataset Export'),
                ],
                max_length=30,
            ),
        ),

        # DocumentChunk model for RAG
        migrations.CreateModel(
            name='DocumentChunk',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('chunk_index', models.PositiveIntegerField(default=0)),
                ('text', models.TextField()),
                ('embedding', models.JSONField(default=list)),
                ('embed_model', models.CharField(default='nomic-embed-text', max_length=100)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('document', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='chunks', to='documents.document')),
                ('project', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='doc_chunks', to='survey_projects.surveyproject')),
            ],
            options={'ordering': ['document', 'chunk_index']},
        ),
        migrations.AddConstraint(
            model_name='documentchunk',
            constraint=models.UniqueConstraint(fields=['document', 'chunk_index'], name='unique_doc_chunk'),
        ),

        # BoundaryExtractionJob model for vision pipeline
        migrations.CreateModel(
            name='BoundaryExtractionJob',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('source_image', models.ImageField(blank=True, null=True, upload_to='boundary_extraction/')),
                ('vision_model', models.CharField(default='llava:7b', max_length=100)),
                ('status', models.CharField(choices=[('PENDING','PENDING'),('RUNNING','RUNNING'),('DONE','DONE'),('FAILED','FAILED')], default='PENDING', max_length=10)),
                ('raw_response', models.TextField(blank=True)),
                ('parsed_result', models.JSONField(blank=True, null=True)),
                ('draft_features', models.JSONField(default=list)),
                ('error_log', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('source_document', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='boundary_extractions', to='documents.document')),
                ('project', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='boundary_extractions', to='survey_projects.surveyproject')),
                ('requested_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL)),
            ],
            options={'ordering': ['-created_at']},
        ),
    ]
