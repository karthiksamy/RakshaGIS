from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0007_alter_organisation_circle_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='sha512_password',
            field=models.CharField(
                blank=True,
                default='',
                help_text='SHA-512 hex digest of the raw password; used for challenge-response login',
                max_length=128,
            ),
        ),
    ]
