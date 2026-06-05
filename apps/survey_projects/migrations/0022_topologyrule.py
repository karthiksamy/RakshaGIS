from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('survey_projects', '0021_reviewannotation'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='TopologyRule',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('rule_type', models.CharField(
                    choices=[
                        ('MUST_NOT_OVERLAP', 'Polygons must not overlap'),
                        ('MUST_BE_INSIDE', 'Features must be inside another layer'),
                        ('MUST_NOT_HAVE_GAPS', 'Polygons must not have gaps'),
                        ('MUST_NOT_DANGLE', 'Lines must not have dangling ends'),
                        ('MUST_COVER_EACH_OTHER', 'Layers must cover each other'),
                    ],
                    max_length=30,
                )),
                ('layer_a', models.CharField(help_text='Primary layer name', max_length=64)),
                ('layer_b', models.CharField(blank=True, help_text='Secondary layer (for MUST_BE_INSIDE, etc.)', max_length=64)),
                ('tolerance', models.FloatField(default=0.00001, help_text='Geometric tolerance in degrees')),
                ('description', models.CharField(blank=True, max_length=200)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('project', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='topology_rules',
                    to='survey_projects.surveyproject',
                )),
                ('created_by', models.ForeignKey(
                    on_delete=django.db.models.deletion.PROTECT,
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={
                'ordering': ['project', 'rule_type', 'layer_a'],
            },
        ),
    ]
