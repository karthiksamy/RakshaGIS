from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ai_assistant', '0004_result_jsonfield'),
    ]

    operations = [
        migrations.AlterField(
            model_name='aitask',
            name='task_type',
            field=models.CharField(
                choices=[
                    ('REPORT_GENERATION', 'Report Generation'),
                    ('PDF_EXTRACTION', 'PDF Text Extraction & Summary'),
                    ('ATTRIBUTE_VALIDATION', 'Attribute Validation'),
                    ('GIS_INDEXING', 'GIS File Indexing'),
                    ('MODEL_PULL', 'Model Pull / Download'),
                ],
                max_length=30,
            ),
        ),
    ]
