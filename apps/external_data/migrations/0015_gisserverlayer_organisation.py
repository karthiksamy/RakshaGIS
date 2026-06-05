from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0008_user_sha512_password'),
        ('external_data', '0014_alter_gisserverconnection_base_url_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='gisserverlayer',
            name='organisation',
            field=models.ForeignKey(
                blank=True,
                help_text='Owning organisation (null = global / SUPERADMIN layer)',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='gis_server_layers',
                to='accounts.organisation',
            ),
        ),
    ]
