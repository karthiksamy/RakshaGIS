from django.conf import settings
import django.contrib.gis.db.models.fields
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('survey_projects', '0020_map_enabled'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='ReviewAnnotation',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('annotation_type', models.CharField(
                    choices=[('redline', 'Redline'), ('comment', 'Comment Pin'), ('highlight', 'Highlight')],
                    default='redline', max_length=12,
                )),
                ('geometry', django.contrib.gis.db.models.fields.GeometryField(srid=4326)),
                ('comment', models.TextField(blank=True)),
                ('color', models.CharField(default='#ff4444', max_length=7)),
                ('is_resolved', models.BooleanField(default=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('survey_area', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='annotations',
                    to='survey_projects.surveyarea',
                )),
                ('created_by', models.ForeignKey(
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name='review_annotations',
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={'ordering': ['-created_at']},
        ),
    ]
