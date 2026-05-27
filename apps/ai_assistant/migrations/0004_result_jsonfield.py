from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ai_assistant', '0003_llmconfig'),
    ]

    operations = [
        # First, fix any rows where result is an empty string or invalid JSON
        migrations.RunSQL(
            sql="UPDATE ai_assistant_aitask SET result = '' WHERE result IS NULL;",
            reverse_sql=migrations.RunSQL.noop,
        ),
        # Alter the column type using USING clause to convert empty string → '{}'
        migrations.RunSQL(
            sql="""
                ALTER TABLE ai_assistant_aitask
                ALTER COLUMN result TYPE jsonb
                USING CASE
                    WHEN result = '' OR result IS NULL THEN '{}'::jsonb
                    ELSE result::jsonb
                END;
            """,
            reverse_sql="""
                ALTER TABLE ai_assistant_aitask
                ALTER COLUMN result TYPE text
                USING result::text;
            """,
        ),
        # Now set the default at the Django ORM level
        migrations.AlterField(
            model_name='aitask',
            name='result',
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
