# SHV — Simple HDRI Viewer

![SHV_preview](https://github.com/user-attachments/assets/8de028dc-b79c-4781-8a14-aa87261cab26)


**Welcome to SHV (Simple HDRI Viewer)** — an open-source web application designed for fast, clean, and distraction-free previewing and evaluation of HDRI maps.  
No cloud uploads, no data collection — everything runs **locally on your device**.

<img width="3439" height="1255" alt="image" src="https://github.com/user-attachments/assets/a750681b-51a6-4076-b243-ede14aeaae70" />

---

## Core Features

### Instant HDRI Preview
Load and inspect your HDRI files in seconds. SHV does not upload or store any data externally — all processing happens locally in your browser.

### Cross-Platform & Device Friendly
SHV supports **x86 and ARM architectures**, making it compatible with desktop PCs, laptops, tablets, and mobile devices.

![SHV_Phone](https://github.com/user-attachments/assets/b91c2c64-949d-4a7c-9c74-6ad71577e828)

### Tonemapping & Color Modes
Preview how your HDRI behaves under different color responses and LUTs using the **Tonemapping** feature.

![SHV_Tonnemaping](https://github.com/user-attachments/assets/ad5f712a-4efc-448e-bec8-3b6c95f141f0)

### Real-Time Light Editor
SHV now allows manually set up multiple light sources using an HDRI image as an interface. In addition, light sources can be also created using a metal sphere in the scene.

![Light_editor](https://github.com/user-attachments/assets/29b2d7f4-ecb0-445b-940f-c0576a7d5315)

> ⚠️ **Known bugs:**
> - The light source point may not match the light source in the scene. 
> - When setting up a light source using a metal sphere, the light intensity is significantly lower and requires additional adjustment.

### Material Test Presets
Evaluate lighting behavior on different materials using built-in presets:
- SHV Default  
- Grayscale  
- Skin Tone  
- Poly Haven

![Presets](https://github.com/user-attachments/assets/d4243455-c42d-49a5-be11-33dae5e0cc4d)

### Custom Preset Creation
Create your own testing presets:

![Screenshot 2025-12-21 090658 copy](https://github.com/user-attachments/assets/dbccd60d-7de8-4496-b15b-7b4c51fef01d)

- Select **Custom Preset**
- Adjust material parameters
- Use **Save Preset** to store it on your device
- Use **Upload Preset** to load it into the current project

### Material Editor
Fine-tune test materials in real time:
- Base color  
- Roughness  
- Metallic values  
- Textures

![Material editor](https://github.com/user-attachments/assets/b0b89e49-7db0-4d67-af1b-523af3513dfc)
Ideal for evaluating specular response, contrast, and surface behavior.


### Color Checker settings are now available, allowing you to adjust your colors in sRGB values.

<img width="390" height="675" alt="image" src="https://github.com/user-attachments/assets/4e68f062-a5fd-407e-95ff-cbf3135f246a" />


### Scene Object Control
Toggle any scene object on or off to focus on specific lighting elements.

<img width="295" height="167" alt="image" src="https://github.com/user-attachments/assets/ed38f881-400f-442f-89b9-3242a628e9c5" />

### Scene Screenshots
Capture high-quality screenshots of the current scene with a single click — perfect for comparisons and documentation.

<img width="64" height="58" alt="image" src="https://github.com/user-attachments/assets/71f75c26-425b-4eb6-b330-bc1fd21bf6d1" />

### Encrypted Project Save & Load
Save and load complete projects using SHV’s **custom encrypted project format**.

![Project_save](https://github.com/user-attachments/assets/6817f1ac-f6a4-4335-af19-6afd0bcf250c)

Projects can include:
- Loaded HDRIs  
- Material presets  
- Related textures  

This allows you to archive, share, or continue working later without exposing raw assets.

---

SHV is built by artist, for artists — simple, fast, and transparent.  
If you care about lighting quality and want a lightweight HDRI inspection tool that stays out of your way, **SHV is the tool for you.**
