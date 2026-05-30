"""
Add all mst_office mirror fields to Organisation.
These allow the RakshaGIS Organisation table to hold a complete replica of
the external mst_office hierarchy (or to be populated from it via the
external_data sync mechanism).
"""
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0005_rename_accounts_ea_user_ts_idx_accounts_ex_user_id_3b43cc_idx_and_more'),
        ('gis_layers', '0001_initial'),
    ]

    operations = [
        # controlling_office FK (differs from parent — represents admin authority)
        migrations.AddField(
            model_name='organisation',
            name='controlling_office',
            field=models.ForeignKey(
                blank=True, null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='controlled_offices',
                to='accounts.organisation',
                help_text='mst_office.controllingoffice',
            ),
        ),
        migrations.AddField(
            model_name='organisation',
            name='office_level_code',
            field=models.CharField(blank=True, max_length=2,
                                   help_text='Raw officelevelid (e.g. L1, L2)'),
        ),
        migrations.AddField(
            model_name='organisation',
            name='office_url',
            field=models.URLField(blank=True, max_length=75),
        ),
        migrations.AddField(
            model_name='organisation',
            name='address1',
            field=models.CharField(blank=True, max_length=75),
        ),
        migrations.AddField(
            model_name='organisation',
            name='address2',
            field=models.CharField(blank=True, max_length=75),
        ),
        migrations.AddField(
            model_name='organisation',
            name='address3',
            field=models.CharField(blank=True, max_length=75),
        ),
        migrations.AddField(
            model_name='organisation',
            name='circle',
            field=models.CharField(blank=True, max_length=50),
        ),
        migrations.AddField(
            model_name='organisation',
            name='display_order',
            field=models.IntegerField(default=0),
        ),
        migrations.AddField(
            model_name='organisation',
            name='fax_nos',
            field=models.CharField(blank=True, max_length=25),
        ),
        migrations.AlterField(
            model_name='organisation',
            name='landline',
            field=models.CharField(blank=True, max_length=50,
                                   help_text='mst_office.phonenos'),
        ),
        migrations.AddField(
            model_name='organisation',
            name='creation_date',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='organisation',
            name='close_date',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='organisation',
            name='doe',
            field=models.DateField(blank=True, null=True,
                                   help_text='Date of Establishment'),
        ),
        migrations.AddField(
            model_name='organisation',
            name='dou',
            field=models.DateField(blank=True, null=True,
                                   help_text='Date of last Update'),
        ),
        migrations.AddField(
            model_name='organisation',
            name='enby',
            field=models.CharField(blank=True, max_length=15),
        ),
        migrations.AddField(
            model_name='organisation',
            name='upby',
            field=models.CharField(blank=True, max_length=15),
        ),
        migrations.AddField(
            model_name='organisation',
            name='csum',
            field=models.TextField(blank=True),
        ),
    ]
