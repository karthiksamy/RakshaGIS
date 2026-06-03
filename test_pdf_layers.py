import fitz

def test_layers():
    # Create a new PDF document
    doc = fitz.open()
    page = doc.new_page(width=595, height=842) # A4
    
    # Create two dummy images (100x100 pixels, solid colors)
    # Red image bytes
    from PIL import Image
    import io
    
    img_red = Image.new("RGB", (100, 100), (255, 0, 0))
    red_bytes = io.BytesIO()
    img_red.save(red_bytes, format="PNG")
    red_bytes = red_bytes.getvalue()
    
    img_blue = Image.new("RGB", (100, 100), (0, 0, 255))
    blue_bytes = io.BytesIO()
    img_blue.save(blue_bytes, format="PNG")
    blue_bytes = blue_bytes.getvalue()
    
    # Add OCGs (Layers)
    red_ocg = doc.add_ocg("Red Layer")
    blue_ocg = doc.add_ocg("Blue Layer")
    
    # Insert images onto the page
    page.insert_image(fitz.Rect(100, 100, 200, 200), stream=red_bytes)
    page.insert_image(fitz.Rect(100, 250, 200, 350), stream=blue_bytes)
    
    # Let's inspect images on the page
    images = page.get_images()
    print("Page images:", images)
    
    # The list contains tuples: (xref, smask, width, height, bpc, colorspace, alt.colorspace, name, filter, referer)
    if len(images) >= 2:
        red_xref = images[0][0]
        blue_xref = images[1][0]
        
        doc.set_oc(red_xref, red_ocg)
        doc.set_oc(blue_xref, blue_ocg)
        print("Associated red_xref", red_xref, "with", red_ocg)
        print("Associated blue_xref", blue_xref, "with", blue_ocg)
        
    doc.save("/app/test_layers_output.pdf")
    doc.close()
    
    # Let's re-open and verify OCGs exist
    doc2 = fitz.open("/app/test_layers_output.pdf")
    print("OCGs in saved file:", doc2.get_ocgs())
    doc2.close()

if __name__ == "__main__":
    test_layers()
