from pathlib import Path
from PIL import Image, ImageDraw
import subprocess
import sys

root = Path(__file__).resolve().parents[1] / 'build'
root.mkdir(exist_ok=True)
image = Image.new('RGBA', (1024, 1024))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((44, 44, 980, 980), radius=216, fill='#2f503d')
draw.rounded_rectangle((54, 54, 970, 970), radius=208, outline='#54715b', width=3)
draw.polygon([(256,279),(448,302),(512,355),(512,772),(444,720),(256,697)], fill='#e9eee0')
draw.polygon([(518,355),(586,302),(770,279),(770,697),(583,720),(518,772)], fill='#ccd9bd')
draw.line([(298,375),(442,393)], fill='#89a27d', width=12)
draw.line([(298,429),(442,447)], fill='#aebfa2', width=12)
draw.line([(298,484),(399,497)], fill='#aebfa2', width=12)
draw.polygon([(669,277),(704,272),(704,479),(686,463),(669,483)], fill='#c4aa74')
image.save(root / 'icon.png')
image.save(root / 'icon.ico', sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)])
icons = root / 'icon.iconset'
icons.mkdir(exist_ok=True)
for size in (16,32,128,256,512):
    image.resize((size,size), Image.Resampling.LANCZOS).save(icons/f'icon_{size}x{size}.png')
    image.resize((size*2,size*2), Image.Resampling.LANCZOS).save(icons/f'icon_{size}x{size}@2x.png')
if sys.platform == 'darwin':
    subprocess.run(['iconutil','-c','icns',str(icons),'-o',str(root/'icon.icns')],check=True)
