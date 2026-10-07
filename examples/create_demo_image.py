"""生成可核对的视觉测试图片：2024=120，2025=150。"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def create_demo_image():
    image = Image.new('RGB', (800, 460), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=32)
    draw.text((40, 30), 'DEMO DATA (units)', fill='black', font=font)
    draw.text((40, 110), '2024: 120', fill='black', font=font)
    draw.rectangle((40, 160, 520, 220), fill='#2563eb')
    draw.text((40, 260), '2025: 150', fill='black', font=font)
    draw.rectangle((40, 310, 640, 370), fill='#16a34a')
    draw.text((40, 410), 'Source: synthetic test fixture', fill='black', font=ImageFont.load_default(size=20))
    path = Path(__file__).resolve().parents[1] / 'images' / 'demo-chart.png'
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    return path


if __name__ == '__main__':
    print(create_demo_image())
