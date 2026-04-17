from pathlib import Path
from PIL import Image


SRC = Path(r"C:\Users\ferga\Downloads\Ícono de pistola de engrase naranja (1).png")
DESTS = [
    Path(r"C:\Users\ferga\Documents\lubriplan-frontend\src\assets\lubriplan-menu-icon.png"),
    Path(r"C:\Users\ferga\Documents\lubriplan-frontend\src\assets\lubriplan-app-icon.png"),
    Path(r"C:\Users\ferga\Documents\lubriplan-frontend\src\assets\lubriplan-logo.png.png"),
]


def main():
    image = Image.open(SRC).convert("RGBA")
    pixels = image.load()
    width, height = image.size

    bbox = [width, height, 0, 0]

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]

            is_orange = r > 200 and g > 70 and g < 180 and b < 120
            is_star = r > 220 and g > 100 and b < 140
            keep = is_orange or is_star

            if keep:
                bbox[0] = min(bbox[0], x)
                bbox[1] = min(bbox[1], y)
                bbox[2] = max(bbox[2], x)
                bbox[3] = max(bbox[3], y)
                continue

            brightness = (r + g + b) / 3
            if brightness > 140:
                pixels[x, y] = (255, 255, 255, 0)
            else:
                pixels[x, y] = (255, 255, 255, 0)

    if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
        cropped = image
    else:
        pad = 10
        left = max(0, bbox[0] - pad)
        top = max(0, bbox[1] - pad)
        right = min(width, bbox[2] + pad + 1)
        bottom = min(height, bbox[3] + pad + 1)
        cropped = image.crop((left, top, right, bottom))

    for dest in DESTS:
        dest.parent.mkdir(parents=True, exist_ok=True)
        cropped.save(dest, "PNG")


if __name__ == "__main__":
    main()
