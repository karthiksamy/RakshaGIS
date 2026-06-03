import io
import json
import zipfile
import xml.etree.ElementTree as ET
from django.test import TestCase
from django.conf import settings
from apps.core.models import ProvenanceRecord
from apps.core.watermark import (
    embed_watermark,
    detect_watermark,
    get_secret_key_bytes,
    perturb_point,
    detect_clpw_watermark,
)

class WatermarkTestCase(TestCase):
    def setUp(self):
        self.metadata = {
            "project_id": 99,
            "project_number": "PRJ-TEST-99",
            "title": "Test File Title",
            "uploaded_by": "test_user",
        }

    def test_pdf_watermarking(self):
        # 1. Embed (registers in DB)
        original_pdf = b"%PDF-1.4\n1 0 obj\n<< /Title (Test) >>\nendobj\n%%EOF"
        watermarked_pdf = embed_watermark(original_pdf, "document.pdf", "application/pdf", self.metadata)
        
        # Verify it appended tail comment
        self.assertTrue(watermarked_pdf.startswith(original_pdf))
        self.assertIn(b"%RAKSHA_WMARK:", watermarked_pdf)
        
        # Check that DB has the record
        self.assertEqual(ProvenanceRecord.objects.filter(file_name="document.pdf").count(), 1)
        
        # 2. Detect
        result = detect_watermark(watermarked_pdf, "document.pdf")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["confidence"], 1.0)
        self.assertEqual(result["metadata"]["project_number"], "PRJ-TEST-99")
        self.assertEqual(result["metadata"]["title"], "Test File Title")
        self.assertEqual(result["verification_method"], "structural_cryptographic_signature")
        self.assertTrue(result["registry_verified"])
        self.assertEqual(result["registry_record"]["file_name"], "document.pdf")

    def test_zip_office_watermarking(self):
        # Create a mock zip/docx in memory
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w") as zf:
            zf.writestr("word/document.xml", "<w:document></w:document>")
        original_bytes = zip_buffer.getvalue()
        
        # 1. Embed
        watermarked_bytes = embed_watermark(original_bytes, "test.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", self.metadata)
        
        # Verify it is still a valid zip and has .raksha-wmark
        with zipfile.ZipFile(io.BytesIO(watermarked_bytes), "r") as zf:
            self.assertIn(".raksha-wmark", zf.namelist())
            self.assertEqual(zf.read("word/document.xml"), b"<w:document></w:document>")
            
        # 2. Detect
        result = detect_watermark(watermarked_bytes, "test.docx")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["metadata"]["project_number"], "PRJ-TEST-99")
        self.assertTrue(result["registry_verified"])

    def test_csv_watermarking(self):
        original_csv = b"id,name,value\n1,Alice,100\n2,Bob,200"
        
        # 1. Embed
        watermarked_csv = embed_watermark(original_csv, "data.csv", "text/csv", self.metadata)
        
        self.assertTrue(watermarked_csv.startswith(b"# RAKSHA_WMARK:"))
        self.assertIn(b"id,name,value", watermarked_csv)
        
        # 2. Detect
        result = detect_watermark(watermarked_csv, "data.csv")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["metadata"]["project_number"], "PRJ-TEST-99")
        self.assertTrue(result["registry_verified"])

    def test_geojson_watermarking_preserves_coordinates(self):
        geojson_data = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [77.12345678, 28.56789012]
                    },
                    "properties": {"name": "Delhi Point"}
                },
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [77.2, 28.6],
                            [77.3, 28.7],
                            [77.4, 28.8]
                        ]
                    },
                    "properties": {}
                }
            ]
        }
        original_bytes = json.dumps(geojson_data).encode("utf-8")

        # 1. Embed
        watermarked_bytes = embed_watermark(original_bytes, "map.geojson", "application/geo+json", self.metadata)

        # Coordinates MUST be left intact — RakshaGIS no longer perturbs survey
        # coordinates to embed a watermark. Provenance rides in a metadata property
        # plus the Trust Registry, not in altered cadastral measurements.
        wm = json.loads(watermarked_bytes.decode("utf-8"))
        self.assertEqual(wm["features"][0]["geometry"]["coordinates"], [77.12345678, 28.56789012])
        self.assertEqual(
            wm["features"][1]["geometry"]["coordinates"],
            [[77.2, 28.6], [77.3, 28.7], [77.4, 28.8]],
        )
        self.assertIn("raksha_watermark", wm)
        self.assertEqual(wm["features"][0]["properties"]["raksha_watermark"], wm["raksha_watermark"])

        # 2. Detect via the embedded metadata token + Trust Registry
        result = detect_watermark(watermarked_bytes, "map.geojson")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["metadata"]["project_number"], "PRJ-TEST-99")
        self.assertEqual(result["verification_method"], "structural_cryptographic_signature")
        self.assertTrue(result["registry_verified"])

    def test_png_real_c2pa_signing_and_detection(self):
        """PNG exports must carry a genuine, signed C2PA manifest (not a tail comment)."""
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (64, 48), (20, 80, 160)).save(buf, format="PNG")
        png = buf.getvalue()

        watermarked = embed_watermark(png, "map_export.png", "image/png", self.metadata)
        # A signed C2PA manifest grows the file substantially (unlike a tail comment).
        self.assertGreater(len(watermarked), len(png) + 1000)

        result = detect_watermark(watermarked, "map_export.png", "image/png")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["verification_method"], "c2pa_signed_manifest")
        self.assertEqual(result["metadata"]["project_number"], "PRJ-TEST-99")
        self.assertEqual(result.get("c2pa", {}).get("validation_state"), "Valid")
        self.assertTrue(result["registry_verified"])

    def test_c2pa_tamper_detection(self):
        """Flipping image content after signing must invalidate the C2PA manifest."""
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (80, 60), (90, 30, 30)).save(buf, format="PNG")
        png = buf.getvalue()
        watermarked = bytearray(embed_watermark(png, "x.png", "image/png", self.metadata))
        watermarked[len(watermarked) // 2] ^= 0xFF   # corrupt a content byte
        result = detect_watermark(bytes(watermarked), "x.png", "image/png")
        # Manifest is still present, but validation must no longer be "Valid".
        self.assertNotEqual(result.get("c2pa", {}).get("validation_state"), "Valid")

    def test_coordinate_lsb_perturbation_precision(self):
        secret_key = get_secret_key_bytes()
        x, y = 77.12345678, 28.56789012
        
        px, py = perturb_point(x, y, secret_key)
        
        # Verify deviation is within 8th decimal place (less than 1.1e-8 units)
        self.assertLessEqual(abs(x - px), 1.1e-8)
        self.assertLessEqual(abs(y - py), 1.1e-8)
        
        # Verify detect_clpw_watermark matches
        res = detect_clpw_watermark([(px, py)], secret_key)
        self.assertEqual(res["matching_count"], 1)
        self.assertEqual(res["total_checked"], 1)

    def test_kml_watermarking(self):
        kml_content = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Test Document</name>
    <Placemark>
      <name>Point A</name>
      <Point>
        <coordinates>77.12345,28.56789</coordinates>
      </Point>
    </Placemark>
  </Document>
</kml>"""
        original_bytes = kml_content.encode("utf-8")
        
        # 1. Embed
        watermarked_kml = embed_watermark(original_bytes, "map.kml", "application/vnd.google-earth.kml+xml", self.metadata)
        
        # 2. Detect
        result = detect_watermark(watermarked_kml, "map.kml")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["metadata"]["project_number"], "PRJ-TEST-99")
        self.assertTrue(result["registry_verified"])

    def test_image_watermarking(self):
        # Create a tiny 8x8 white PNG in memory
        from PIL import Image
        img = Image.new("RGB", (8, 8), color="white")
        img_buf = io.BytesIO()
        img.save(img_buf, format="PNG")
        original_png = img_buf.getvalue()
        
        # 1. Embed
        watermarked_png = embed_watermark(original_png, "image.png", "image/png", self.metadata)
        
        # 2. Detect
        result = detect_watermark(watermarked_png, "image.png")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["metadata"]["project_number"], "PRJ-TEST-99")
        self.assertEqual(result["verification_method"], "structural_cryptographic_signature")
        self.assertTrue(result["registry_verified"])

    def test_clpw_fallback_with_registry(self):
        # Create coordinates with at least 4 vertices to trigger statistical significance
        geojson_data = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [77.12345678, 28.56789012],
                        [77.22345678, 28.66789012],
                        [77.32345678, 28.76789012],
                        [77.42345678, 28.86789012]
                    ]
                },
                "properties": {}
            }]
        }
        original_bytes = json.dumps(geojson_data).encode("utf-8")
        
        # 1. Embed (creates registry record and perturbs coords)
        watermarked_bytes = embed_watermark(original_bytes, "clpw_map.geojson", "application/geo+json", self.metadata)
        
        # 2. Strip metadata token manually to simulate adversary tampering
        data = json.loads(watermarked_bytes.decode('utf-8'))
        if 'raksha_watermark' in data:
            del data['raksha_watermark']
        for f in data['features']:
            if 'properties' in f and 'raksha_watermark' in f['properties']:
                del f['properties']['raksha_watermark']
                
        stripped_bytes = json.dumps(data).encode('utf-8')
        
        # 3. Detect (should fall back to CLPW and verify coordinate LSB matches)
        result = detect_watermark(stripped_bytes, "clpw_map.geojson")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["verification_method"], "coordinate_lsb_perturbation")
        self.assertTrue(result["clpw"]["matched"])


from rest_framework.test import APITestCase
from django.contrib.auth import get_user_model
from apps.accounts.models import Organisation
from django.core.files.uploadedfile import SimpleUploadedFile

class WatermarkAPITestCase(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.org = Organisation.objects.create(name="Test Org", code="TESTORG")
        self.user = User.objects.create_user(
            username="testuser",
            password="testpassword",
            organisation=self.org,
            role="SURVEYOR"
        )
        self.client.force_authenticate(user=self.user)

    def test_export_map_api(self):
        # Test Mapnik PNG export via custom renderer
        response = self.client.post('/api/core/export-map/', {
            "width": 100,
            "height": 100,
            "zoom": 10,
            "center_lon": 78.0,
            "center_lat": 20.0,
            "style": "boundaries"
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['content-type'], 'image/png')
        self.assertTrue(response.content.startswith(b'\x89PNG\r\n\x1a\n'))
        
        # Verify it has Living Provenance DNA watermark
        result = detect_watermark(response.content, "map.png")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["metadata"]["uploaded_by"], "testuser")
        self.assertEqual(result["metadata"]["export_format"], "png")

    def test_verify_watermark_limit(self):
        from unittest.mock import patch, PropertyMock

        # 1. Under limit (20MB)
        file_20mb = SimpleUploadedFile("map.png", b"fake png data")
        with patch('django.core.files.uploadedfile.UploadedFile.size', new_callable=PropertyMock) as mock_size:
            mock_size.return_value = 20 * 1024 * 1024
            response = self.client.post('/api/documents/verify-watermark/', {'file': file_20mb}, format='multipart')
            self.assertEqual(response.status_code, 200)
            self.assertFalse(response.data["watermarked"])

        # 2. At 100MB limit
        file_100mb = SimpleUploadedFile("map.png", b"fake png data")
        with patch('django.core.files.uploadedfile.UploadedFile.size', new_callable=PropertyMock) as mock_size:
            mock_size.return_value = 100 * 1024 * 1024
            response = self.client.post('/api/documents/verify-watermark/', {'file': file_100mb}, format='multipart')
            self.assertEqual(response.status_code, 200)
            self.assertFalse(response.data["watermarked"])

        # 3. Exceeding 100MB limit
        file_exceeding = SimpleUploadedFile("map.png", b"fake png data")
        with patch('django.core.files.uploadedfile.UploadedFile.size', new_callable=PropertyMock) as mock_size:
            mock_size.return_value = 100 * 1024 * 1024 + 1
            response = self.client.post('/api/documents/verify-watermark/', {'file': file_exceeding}, format='multipart')
            self.assertEqual(response.status_code, 400)
            if hasattr(response, 'data') and response.data is not None:
                self.assertIn("File size exceeds the 100MB limit.", response.data.get("detail", ""))
            else:
                self.assertIn(b"File size exceeds the 100MB limit.", response.content)

    def test_watermark_file_api(self):
        # Test PDF watermarking via /api/core/watermark-file/
        original_pdf = b"%PDF-1.4\n1 0 obj\n<< /Title (Test) >>\nendobj\n%%EOF"
        pdf_file = SimpleUploadedFile("printed_map.pdf", original_pdf, content_type="application/pdf")
        
        response = self.client.post('/api/core/watermark-file/', {'file': pdf_file}, format='multipart')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['content-type'], 'application/pdf')
        
        # Verify it has Living Provenance DNA watermark
        result = detect_watermark(response.content, "printed_map.pdf")
        self.assertTrue(result["watermarked"])
        self.assertEqual(result["metadata"]["uploaded_by"], "testuser")
        self.assertEqual(result["metadata"]["export_format"], "pdf")

    def test_pdf_layers_injection(self):
        import fitz
        from PIL import Image
        import io
        
        # Create a mock PDF using fitz
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        
        # Insert two solid color dummy images
        img1 = Image.new("RGB", (50, 50), (255, 0, 0))
        img2 = Image.new("RGB", (50, 50), (0, 0, 255))
        b1 = io.BytesIO()
        img1.save(b1, format="PNG")
        b2 = io.BytesIO()
        img2.save(b2, format="PNG")
        
        page.insert_image(fitz.Rect(10, 10, 60, 60), stream=b1.getvalue())
        page.insert_image(fitz.Rect(70, 70, 120, 120), stream=b2.getvalue())
        
        original_pdf_bytes = doc.tobytes()
        doc.close()
        
        # Embed watermark with layer metadata
        metadata = dict(self.setUp.__code__.co_consts or {})
        metadata = {
            "project_id": 99,
            "project_number": "PRJ-TEST-99",
            "title": "Test File Title",
            "uploaded_by": "test_user",
            "layers": ["Base Map Layer", "Vector Features Layer"]
        }
        
        watermarked_bytes = embed_watermark(original_pdf_bytes, "project_map.pdf", "application/pdf", metadata)
        
        # Read back and verify OCG layers exist
        doc2 = fitz.open(stream=watermarked_bytes, filetype="pdf")
        ocgs = doc2.get_ocgs()
        self.assertGreaterEqual(len(ocgs), 2)
        
        names = [ocg["name"] for ocg in ocgs.values()]
        self.assertIn("Base Map Layer", names)
        self.assertIn("Vector Features Layer", names)
        
        doc2.close()
        
        result = detect_watermark(watermarked_bytes, "project_map.pdf")
        self.assertTrue(result["watermarked"])



