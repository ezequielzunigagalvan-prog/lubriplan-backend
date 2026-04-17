from pathlib import Path
from PIL import Image

SRC = Path(r"C:\Users\ferga\Downloads\Ícono de pistola de grasa naranja.png")
DEST = Path(r"C:\Users\ferga\Documents\lubriplan-frontend\public\apple-touch-icon.png")


def is_background(pixel):
    r, g, b, a = pixel
    return a == 0 or (r > 245 and g > 245 and b > 245)


def main():
    image = Image.open(SRC).convert("RGBA")
    width, height = image.size
    pixels = image.load()

    left, top, right, bottom = width, height, -1, -1

    for y in range(height):
      for x in range(width):
        if not is_background(pixels[x, y]):
          left = min(left, x)
          top = min(top, y)
          right = max(right, x)
          bottom = max(bottom, y)

    if right < left or bottom < top:
        cropped = image
    else:
        pad = 6
        cropped = image.crop(
            (
                max(0, left - pad),
                max(0, top - pad),
                min(width, right + pad + 1),
                min(height, bottom + pad + 1),
            )
        )

    final = cropped.resize((180, 180), Image.LANCZOS)
    DEST.parent.mkdir(parents=True, exist_ok=True)
    final.save(DEST, "PNG")


if __name__ == "__main__":
    main()
