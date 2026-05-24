from django.contrib.gis.db import models


class State(models.Model):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=5, unique=True)
    geometry = models.MultiPolygonField(srid=4326)

    def __str__(self):
        return self.name


class District(models.Model):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=10, unique=True)
    state = models.ForeignKey(State, on_delete=models.PROTECT, related_name='districts')
    geometry = models.MultiPolygonField(srid=4326)

    def __str__(self):
        return f"{self.name}, {self.state.name}"


class Taluk(models.Model):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=15, unique=True)
    district = models.ForeignKey(District, on_delete=models.PROTECT, related_name='taluks')
    geometry = models.MultiPolygonField(srid=4326)

    def __str__(self):
        return f"{self.name}, {self.district.name}"


class Village(models.Model):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=20, unique=True)
    taluk = models.ForeignKey(Taluk, on_delete=models.PROTECT, related_name='villages')
    geometry = models.MultiPolygonField(srid=4326)

    def __str__(self):
        return f"{self.name}, {self.taluk.name}"


class RevenueMap(models.Model):
    survey_number = models.CharField(max_length=50)
    village = models.ForeignKey(Village, on_delete=models.PROTECT, related_name='revenue_maps')
    geometry = models.MultiPolygonField(srid=4326)
    area_hectares = models.DecimalField(max_digits=12, decimal_places=4, null=True, blank=True)
    classification = models.CharField(max_length=100, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        unique_together = ['survey_number', 'village']

    def __str__(self):
        return f"Survey {self.survey_number} — {self.village.name}"
