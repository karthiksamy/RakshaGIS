from django.db import migrations, models


def set_initial_default(apps, schema_editor):
    """Promote the first active basemap to default when none is set yet."""
    BasemapConfig = apps.get_model('core', 'BasemapConfig')
    if BasemapConfig.objects.filter(is_default=True).exists():
        return
    first = BasemapConfig.objects.filter(is_active=True).order_by('name').first()
    if first is None:
        first = BasemapConfig.objects.order_by('name').first()
    if first is not None:
        first.is_default = True
        first.save(update_fields=['is_default'])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0003_alter_brandingconfig_id'),
    ]

    operations = [
        migrations.AddField(
            model_name='basemapconfig',
            name='is_default',
            field=models.BooleanField(
                default=False,
                help_text='Default basemap loaded when the map opens. Only one may be default.',
            ),
        ),
        migrations.AlterModelOptions(
            name='basemapconfig',
            options={'ordering': ['-is_default', 'name']},
        ),
        migrations.RunPython(set_initial_default, noop),
    ]
