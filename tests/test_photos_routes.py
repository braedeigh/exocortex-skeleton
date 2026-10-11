"""routes/photos.py — uploaded photos and their thumbnails, for the journal.

The behaviors that must not silently break: a photo is found whether it's
still in the uploads inbox or already swept into the archive; no name can
reach outside those two folders; thumbnails are small, upright (phone photos
store "which way is up" as a tag), white where the original was transparent,
and made once then reused; a file that isn't really an image is a clean 415.
"""
import io

import pytest
from flask import Flask
from PIL import Image

import store
from routes import photos


@pytest.fixture
def client(data_dir):
    store.UPLOAD_DIR.mkdir(parents=True)
    store.UPLOAD_ARCHIVE_DIR.mkdir(parents=True)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    photos.register(app)
    return app.test_client()


def _save(path, size=(800, 400), color=(200, 30, 30), mode="RGB", exif_orientation=None):
    image = Image.new(mode, size, color)
    kwargs = {}
    if exif_orientation:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation
        kwargs["exif"] = exif
    image.save(path, **kwargs)


def _image(resp):
    return Image.open(io.BytesIO(resp.data))


def test_photo_is_served_from_the_inbox(client):
    _save(store.UPLOAD_DIR / "20260918_204338_IMG_1.png")
    assert client.get("/api/photos/20260918_204338_IMG_1.png").status_code == 200


def test_photo_is_found_after_the_sweep_files_it(client):
    _save(store.UPLOAD_ARCHIVE_DIR / "20260101_000000_IMG_2.jpeg")
    assert client.get("/api/photos/20260101_000000_IMG_2.jpeg").status_code == 200


@pytest.mark.parametrize("name", [
    "..%2Fsecret.png", ".hidden.png", "notes.txt", "20260918_paste.txt", "missing.png",
])
def test_names_outside_the_upload_folders_are_404(client, name):
    (store.DATA_DIR / "secret.png").write_bytes(b"x")
    assert client.get(f"/api/photos/{name}").status_code == 404
    assert client.get(f"/api/photos/{name}/thumb").status_code == 404


def test_thumbnail_is_a_small_jpeg(client):
    _save(store.UPLOAD_DIR / "big.png", size=(1600, 800))
    resp = client.get("/api/photos/big.png/thumb")
    image = _image(resp)
    assert (resp.mimetype, image.format, image.size) == ("image/jpeg", "JPEG", (240, 120))


def test_thumbnail_turns_a_sideways_phone_photo_upright(client):
    # Stored wide, tagged "rotate 90°" (orientation 6), the way phones do it.
    _save(store.UPLOAD_DIR / "phone.jpg", size=(800, 400), exif_orientation=6)
    assert _image(client.get("/api/photos/phone.jpg/thumb")).size == (120, 240)


def test_thumbnail_puts_transparency_on_white(client):
    _save(store.UPLOAD_DIR / "clear.png", size=(100, 100), color=(0, 0, 0, 0), mode="RGBA")
    r, g, b = _image(client.get("/api/photos/clear.png/thumb")).getpixel((50, 50))
    assert min(r, g, b) > 240


def test_thumbnail_is_made_once_and_reused(client):
    _save(store.UPLOAD_DIR / "once.png")
    client.get("/api/photos/once.png/thumb")
    cached = store.THUMB_DIR / f"once.png.{photos.THUMB_PIXELS}.jpg"
    cached.write_bytes(_jpeg_marker())
    assert client.get("/api/photos/once.png/thumb").data == _jpeg_marker()


def _jpeg_marker():
    buf = io.BytesIO()
    Image.new("RGB", (1, 1)).save(buf, "JPEG")
    return buf.getvalue()


def test_a_file_that_isnt_an_image_is_a_415(client):
    (store.UPLOAD_DIR / "broken.png").write_bytes(b"not a png")
    assert client.get("/api/photos/broken.png/thumb").status_code == 415
