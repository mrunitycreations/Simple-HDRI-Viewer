
import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, signal, effect, AfterViewInit, WritableSignal, inject, Injector, runInInjectionContext, computed } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MathUtils } from 'three';
import { SecureCryptoService } from './services/secure-crypto.service';

interface HDRI {
  name: string;
  url: string; // Object URL
  file?: File; // Original file, needed for saving
  lights: ManualLight[]; // Lights associated with this HDRI
}

interface ManualLight {
  id: string;
  u: number;
  v: number;
  color: string; // Hex
  intensity: number;
  castShadow: boolean;
  instance?: THREE.DirectionalLight;
}

type ToneMappingOption = 'Reinhard' | 'Cineon' | 'Grayscale' | 'None';
type ColorSpaceOption = 'Linear sRGB' | 'ACES Filmic';
type EditableMaterial = 'Floor' | 'Glass' | 'Matte' | 'Chrome' | 'Plastic' | 'Color Checker';
type Preset = 'SHV' | 'Polyhaven' | 'Grayscale' | 'SkinTone' | 'Custom';
type Theme = 'light' | 'dark';

// --- Project Data Interfaces for Saving/Loading ---
interface TextureData {
  name: string;
  data: string; // base64 string
  encrypted?: boolean;
  iv?: string; // Asset IV
  wrappedKey?: string; // Encrypted DEK (V1.7+)
  keyIv?: string;      // IV used to encrypt the DEK (V1.7+)
}

type ColorCheckerColors = string[]; // Array of 24 hex strings

// V1.7: Envelope Encryption
interface ProjectDataV1_7 {
  version: '1.7';
  settings: {
    rotation: number;
    exposure: number;
    blur: number;
    selectedHdriName: string | null;
    toneMapping: ToneMappingOption;
    spheresVisible: boolean;
    groundVisible: boolean;
    colorCheckerVisible: boolean;
    colorSpace?: ColorSpaceOption;
  };
  materials: {
    floor: { tiling: number; texture: TextureData | null; };
    glass: { roughness: number; ior: number; roughnessTexture: TextureData | null; };
    matte: { color: string; roughness: number; metalness: number; roughnessTexture: TextureData | null; };
    chrome: { color: string; roughness: number; metalness: number; roughnessTexture: TextureData | null; };
    plastic: { color: string; roughness: number; metalness: number; roughnessTexture: TextureData | null; };
    colorChecker?: { colors: ColorCheckerColors; }
  };
  hdris: { 
      name: string; 
      data: string; 
      lights: ManualLight[];
      encrypted: boolean;
      iv: string; 
      wrappedKey: string;
      keyIv: string;
  }[];
  loadedPreset?: {
      name: string;
      data: CustomPresetData;
  };
}

// ... (Previous Interfaces V1.6 - V1.0 retained for compatibility) ...
interface ProjectDataV1_6 { version: '1.6'; [key: string]: any; }
interface ProjectDataV1_5 { version: '1.5'; [key: string]: any; }
interface ProjectDataV1_4 { version: '1.4'; [key: string]: any; }
interface ProjectDataV1_3 { version: '1.3'; [key: string]: any; }
interface ProjectDataV1_2 { version: '1.2'; [key: string]: any; }
interface ProjectDataV1_1 { version: '1.1'; [key: string]: any; }
interface ProjectDataV1_0 { version: '1.0'; [key: string]: any; }

type AnyProjectData = ProjectDataV1_7 | ProjectDataV1_6 | ProjectDataV1_5 | ProjectDataV1_4 | ProjectDataV1_3 | ProjectDataV1_2 | ProjectDataV1_1 | ProjectDataV1_0;

interface CustomPresetData {
  version: '1.0';
  materials: {
    glass: { color: string; roughness: number; ior: number; transmission: number; };
    matte: { color: string; roughness: number; metalness: number; };
    chrome: { color: string; roughness: number; metalness: number; };
    plastic: { color: string; roughness: number; metalness: number; };
  };
  visibility: {
    spheres: boolean;
    colorChecker: boolean;
    ground: boolean;
  };
  colorChecker: {
    colors: string[][];
  };
}

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements AfterViewInit {
  @ViewChild('rendererCanvas', { static: true })
  rendererCanvas!: ElementRef<HTMLCanvasElement>;
  
  @ViewChild('hdriPreviewImage')
  hdriPreviewImage!: ElementRef<HTMLImageElement>;

  // UI State Signals
  rotation = signal(0);
  exposure = signal(1);
  blur = signal(0);
  isLoading = signal(true);
  loadingMessage = signal('Initializing Scene...');
  spheresVisible = signal(true);
  groundVisible = signal(true);
  colorCheckerVisible = signal(true);
  toneMapping = signal<ToneMappingOption>('Reinhard');
  colorSpace = signal<ColorSpaceOption>('ACES Filmic');
  anyObjectVisible = computed(() => this.spheresVisible() || this.colorCheckerVisible() || this.groundVisible());
  isMaterialEditorOpen = signal(false);
  isLightEditorOpen = signal(false);
  isPickingLight = signal(false); // Mode for picking light from scene
  isAboutPanelOpen = signal(false);
  aboutPanelActiveTab = signal<'about' | 'how-to' | 'changelog'>('about');

  // HDRI Management Signals
  hdriList: WritableSignal<HDRI[]> = signal([]);
  selectedHdriName = signal<string | null>(null);
  hdriPreviewUrl = signal<string | null>(null);
  private currentHdriData: Float32Array | null = null;
  private currentHdriWidth = 0;
  private currentHdriHeight = 0;

  // Light Editor Signals
  manualLights = signal<ManualLight[]>([]);
  selectedLightId = signal<string | null>(null);
  private isDraggingLight = false;

  // Preset Management
  presets: Preset[] = ['SHV', 'Polyhaven', 'Grayscale', 'SkinTone', 'Custom'];
  currentPreset = signal<Preset>('SHV');
  customPresetName = signal<string | null>(null);
  loadedPresetData = signal<CustomPresetData | null>(null);

  // Theme Management
  theme = signal<Theme>('dark');

  // Material Editor Signals
  selectedMaterial = signal<EditableMaterial>('Floor');
  // Floor
  floorTiling = signal(40);
  // Glass Sphere
  glassColor = signal('#ffffff');
  glassRoughness = signal(0);
  glassIor = signal(1.5);
  glassTransmission = signal(1);
  // Matte Sphere
  matteColor = signal('#ffffff');
  matteRoughness = signal(1);
  matteMetalness = signal(0);
  // Chrome Sphere
  chromeColor = signal('#ffffff');
  chromeRoughness = signal(0);
  chromeMetalness = signal(1);
  // Plastic Sphere
  plasticColor = signal('#00bcd4');
  plasticRoughness = signal(0.1);
  plasticMetalness = signal(0.05);
  // Color Checker
  colorCheckerColors = signal<string[][]>([]);

  // Custom texture file tracking
  floorTextureFile = signal<File | null>(null);
  glassRoughnessTextureFile = signal<File | null>(null);
  matteRoughnessTextureFile = signal<File | null>(null);
  chromeRoughnessTextureFile = signal<File | null>(null);
  plasticRoughnessTextureFile = signal<File | null>(null);


  // Three.js properties
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private pmremGenerator!: THREE.PMREMGenerator;
  private ambientLight!: THREE.AmbientLight;
  private groundObject!: THREE.Mesh;
  private sphereObjects: THREE.Mesh[] = [];
  private colorCheckerObject!: THREE.Group;
  private colorCheckerPatches: THREE.Mesh[][] = [];
  private textureLoader = new THREE.TextureLoader();
  
  private readonly defaultColorCheckerColors = [
      // Row 1: Natural colors
      [115, 82, 68],   // #735244 Dark skin
      [194, 150, 130],  // #c29682 Light skin
      [98, 122, 157],   // #627a9d Blue sky
      [87, 108, 67],    // #576c43 Foliage
      [133, 128, 177],  // #8580b1 Blue flower
      [103, 189, 170],  // #67bdaa Bluish green
      // Row 2: Miscellaneous colors
      [214, 126, 44],   // #d67e2c Orange
      [80, 91, 166],    // #505ba6 Purplish blue
      [193, 90, 99],    // #c15a63 Moderate red
      [94, 60, 108],    // #5e3c6c Purple
      [157, 188, 64],   // #9dbc40 Yellow green
      [224, 163, 46],   // #e0a32e Orange yellow
      // Row 3: Primary and secondary colors
      [56, 61, 150],    // #383d96 Blue
      [70, 148, 73],    // #469449 Green
      [175, 54, 60],    // #af363c Red
      [231, 199, 31],   // #e7c71f Yellow
      [187, 86, 149],   // #bb5695 Magenta
      [8, 133, 161],    // #0885a1 Cyan
      // Row 4: Grayscale colors
      [243, 243, 243],  // #f3f3f3 White
      [200, 200, 200],  // #c8c8c8 Neutral 8
      [160, 160, 160],  // #a0a0a0 Neutral 6.5
      [122, 122, 122],  // #7a7a7a Neutral 5
      [85, 85, 85],     // #555555 Neutral 3.5
      [52, 52, 52]      // #343434 Black
  ];

  // Properties for object selection
  private raycaster!: THREE.Raycaster;
  private pointer!: THREE.Vector2;
  private selectableObjects: THREE.Object3D[] = [];
  private selectedObjectForEditing: THREE.Object3D | null = null;
  private originalEmissiveColors = new Map<string, THREE.Color>();
  private highlightTimeoutId: any = null;

  private injector = inject(Injector);
  private cryptoService = inject(SecureCryptoService);

  constructor() {
    // Effect to load a new HDRI when selection changes
    effect(() => {
      const name = this.selectedHdriName();
      if (name) {
        const hdri = this.hdriList().find(h => h.name === name);
        if (hdri) {
          this.loadHdri(hdri.url, `Loading ${hdri.name}...`);
        }
      }
    });

    // Effect to apply the theme class to the document
    runInInjectionContext(this.injector, () => {
      effect(() => {
          const theme = this.theme();
          if (theme === 'dark') {
              document.documentElement.classList.add('dark');
          } else {
              document.documentElement.classList.remove('dark');
          }
      });
    });
    
    // Cleanup Pick Mode if Light Editor closes
    effect(() => {
        if (!this.isLightEditorOpen()) {
            this.isPickingLight.set(false);
            this.isDraggingLight = false;
        }
    });
  }

  ngAfterViewInit(): void {
    this.initThree();
    this.createSceneContent();
    this.renderer.domElement.addEventListener('click', this.onObjectClick.bind(this));
    this.animate();
    this.setupSceneUpdateEffects();
    this.setupMaterialUpdateEffects();
    this.setupPresetEffect();
    this.setupSelectionEffects();
    this.setupLightEffects();
    this.isLoading.set(false);
  }

  private setupSelectionEffects(): void {
    runInInjectionContext(this.injector, () => {
        // Effect to handle cleanup when material editor is closed
        effect(() => {
            const isOpen = this.isMaterialEditorOpen();
            if (!isOpen) {
                this.highlightObject(null);
            }
        });

        // Effect to sync dropdown selection with highlighted object
        effect(() => {
            // Re-run when selectedMaterial or theme changes
            const materialName = this.selectedMaterial();
            this.theme(); // dependency

            if (this.isMaterialEditorOpen()) {
                let objectToHighlight: THREE.Object3D | null = null;
                if (materialName === 'Color Checker') {
                    objectToHighlight = this.colorCheckerObject;
                } else {
                    objectToHighlight = this.selectableObjects.find(o => o.name === materialName) || null;
                }
                this.highlightObject(objectToHighlight);
            }
        });
    });
  }
  
  private setupLightEffects(): void {
      runInInjectionContext(this.injector, () => {
          effect(() => {
              const lights = this.manualLights();
              const rotation = this.rotation();

              // Update existing lights or create new ones
              lights.forEach(lightData => {
                  let light = lightData.instance;

                  if (!light) {
                      light = new THREE.DirectionalLight(lightData.color, lightData.intensity);
                      light.castShadow = lightData.castShadow;
                      
                      // Shadow settings
                      light.shadow.mapSize.width = 4096;
                      light.shadow.mapSize.height = 4096;
                      light.shadow.camera.near = 0.5;
                      light.shadow.camera.far = 100;
                      light.shadow.camera.left = -15;
                      light.shadow.camera.right = 15;
                      light.shadow.camera.top = 15;
                      light.shadow.camera.bottom = -15;
                      light.shadow.radius = 2;
                      light.shadow.blurSamples = 8;
                      
                      this.scene.add(light);
                      lightData.instance = light;

                      // Explicitly set target to 0,0,0 and add to scene to ensure direction is correct
                      light.target.position.set(0, 0, 0);
                      this.scene.add(light.target);
                  }

                  // Update properties
                  light.color.set(lightData.color);
                  light.intensity = lightData.intensity;
                  light.castShadow = lightData.castShadow;

                  // Update position based on UV + Global Rotation
                  // Using Standard Equirectangular mapping: theta = (u - 0.5) * 2PI
                  // This aligns standard U=0.5 (Center) with Theta=0 (+Z)
                  const theta = (lightData.u - 0.5) * 2 * Math.PI; 
                  const phi = lightData.v * Math.PI;
                  
                  // Correct phi to ensure we don't hit exactly 0 or PI (singularity)
                  const correctedPhi = Math.max(0.0001, Math.min(Math.PI - 0.0001, phi));
                  
                  const lightDirection = new THREE.Vector3();
                  lightDirection.setFromSphericalCoords(1, correctedPhi, theta);
                  
                  // Apply global scene rotation
                  // Scene background rotates by `rotation * 2PI`.
                  // The light must rotate with the background.
                  const globalRotRadians = rotation * Math.PI * 2;
                  lightDirection.applyAxisAngle(new THREE.Vector3(0, 1, 0), globalRotRadians);
                  
                  light.position.copy(lightDirection).multiplyScalar(50);
                  light.updateMatrixWorld();
                  light.target.updateMatrixWorld();
              });

              // Cleanup removed lights (Simplified: Only works if we don't have other dir lights)
          });
      });
  }

  private setupSceneUpdateEffects(): void {
    runInInjectionContext(this.injector, () => {
      // Effect to update scene based on rotation
      effect(() => {
        const rot = this.rotation();
        if (this.scene) {
          const radians = rot * Math.PI * 2;
          this.scene.backgroundRotation.y = radians;
          this.scene.environmentRotation.y = radians;
          
          // Lights are updated in setupLightEffects dependent on rotation()
        }
      });

      // Effect to update scene based on blur
      effect(() => {
        if (this.scene) {
          this.scene.backgroundBlurriness = this.blur();
        }
      });
      
      // Effect for Color Pipeline (Space and Tone Mapping)
      effect(() => {
        if (this.renderer) {
          const space = this.colorSpace();
          const mapping = this.toneMapping();

          if (space === 'ACES Filmic') {
            this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
          } else { 
            switch (mapping) {
              case 'Reinhard':
                this.renderer.toneMapping = THREE.ReinhardToneMapping;
                break;
              case 'Cineon':
                this.renderer.toneMapping = THREE.CineonToneMapping;
                break;
              case 'Grayscale': 
                this.renderer.toneMapping = THREE.ReinhardToneMapping;
                break;
              case 'None':
                this.renderer.toneMapping = THREE.NoToneMapping;
                break;
            }
          }
          
          this.renderer.outputColorSpace = THREE.SRGBColorSpace;
          
          this.scene.traverse((object) => {
              if ((object as THREE.Mesh).material) {
                  const material = (object as THREE.Mesh).material;
                  if (Array.isArray(material)) {
                      material.forEach(m => m.needsUpdate = true);
                  } else {
                      material.needsUpdate = true;
                  }
              }
          });
        }
      });

      // Object visibility
      effect(() => {
        const showSpheres = this.spheresVisible();
        const showColorChecker = this.colorCheckerVisible();

        for (const sphere of this.sphereObjects) {
          sphere.visible = showSpheres;
        }

        if (this.colorCheckerObject) {
          this.colorCheckerObject.visible = showColorChecker;
        }

        if (this.groundObject) {
          this.groundObject.visible = this.groundVisible();
        }
      });
    });
  }

  private setupMaterialUpdateEffects(): void {
    runInInjectionContext(this.injector, () => {
        // Floor
        effect(() => {
            const tiling = this.floorTiling();
            const material = this.groundObject?.material as THREE.MeshStandardMaterial;
            if (material?.map) {
                material.map.repeat.set(tiling, tiling);
            }
            if (material?.bumpMap) {
                material.bumpMap.repeat.set(tiling, tiling);
            }
        });

        // Glass
        effect(() => {
            const material = this.sphereObjects[0]?.material as THREE.MeshPhysicalMaterial;
            if (material) {
                material.color.set(this.glassColor());
                material.roughness = this.glassRoughness();
                material.ior = this.glassIor();
                material.transmission = this.glassTransmission();
            }
        });

        // Matte
        effect(() => {
            const material = this.sphereObjects[1]?.material as THREE.MeshStandardMaterial;
            if (material) {
                material.color.set(this.matteColor());
                material.roughness = this.matteRoughness();
                material.metalness = this.matteMetalness();
            }
        });

        // Chrome
        effect(() => {
            const material = this.sphereObjects[2]?.material as THREE.MeshStandardMaterial;
            if (material) {
                material.color.set(this.chromeColor());
                material.roughness = this.chromeRoughness();
                material.metalness = this.chromeMetalness();
            }
        });

        // Plastic
        effect(() => {
            const material = this.sphereObjects[3]?.material as THREE.MeshStandardMaterial;
            if (material) {
                material.color.set(this.plasticColor());
                material.roughness = this.plasticRoughness();
                material.metalness = this.plasticMetalness();
            }
        });
    });
  }

  private setupPresetEffect(): void {
    runInInjectionContext(this.injector, () => {
        effect(() => {
            this.applyPreset(this.currentPreset());
        });
    });
  }

  private initThree(): void {
    this.scene = new THREE.Scene();
    const canvas = this.rendererCanvas.nativeElement;
    
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);

    // Camera
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 1.5, 8);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 20;
    this.controls.target.set(0, 1, 0);
    this.controls.update();

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    window.addEventListener('resize', this.onWindowResize.bind(this));
  }

  // ... (Helper methods for texture creation remain unchanged)
  private createCheckerboardTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not get 2D context from canvas');
    const size = 128; const halfSize = size / 2;
    context.fillStyle = '#555'; context.fillRect(0, 0, size, size);
    context.fillStyle = '#999'; context.fillRect(0, 0, halfSize, halfSize);
    context.fillRect(halfSize, halfSize, halfSize, halfSize);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(this.floorTiling(), this.floorTiling());
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private createCheckerboardBumpMap(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not get 2D context from canvas');
    const size = 128; const halfSize = size / 2;
    context.fillStyle = '#000000'; context.fillRect(0, 0, size, size);
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, halfSize, halfSize);
    context.fillRect(halfSize, halfSize, halfSize, halfSize);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(this.floorTiling(), this.floorTiling());
    return texture;
  }
  
  private createColorChecker(): THREE.Group {
    const colorCheckerGroup = new THREE.Group();
    colorCheckerGroup.name = 'Color Checker Group';
    const rows = 4; const cols = 6; const patchSize = 0.5; const patchMargin = 0.05;
    const totalWidth = cols * patchSize + (cols - 1) * patchMargin;
    const totalHeight = rows * patchSize + (rows - 1) * patchMargin;
    const geometry = new THREE.BoxGeometry(patchSize, patchSize, 0.1);
    this.colorCheckerPatches = [];
    for (let i = 0; i < rows; i++) this.colorCheckerPatches.push([]);
    const initialColors: string[][] = [];
    for (let i = 0; i < this.defaultColorCheckerColors.length; i++) {
      const row = Math.floor(i / cols); const col = i % cols;
      const colorValues = this.defaultColorCheckerColors[i];
      const color = new THREE.Color().setRGB(colorValues[0] / 255, colorValues[1] / 255, colorValues[2] / 255)
      if (!initialColors[row]) initialColors[row] = [];
      initialColors[row][col] = '#' + color.getHexString();
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1 });
      const patch = new THREE.Mesh(geometry, material);
      patch.castShadow = true; patch.receiveShadow = true; patch.name = 'Color Checker';
      const x = col * (patchSize + patchMargin) - totalWidth / 2 + patchSize / 2;
      const y = (rows - 1 - row) * (patchSize + patchMargin) - totalHeight / 2 + patchSize / 2;
      patch.position.set(x, y, 0);
      colorCheckerGroup.add(patch);
      this.colorCheckerPatches[row].push(patch);
      this.selectableObjects.push(patch);
    }
    this.colorCheckerColors.set(initialColors);
    colorCheckerGroup.position.set(0, 3, -1.5);
    colorCheckerGroup.rotation.x = -Math.PI / 16;
    return colorCheckerGroup;
  }

  private createSceneContent(): void {
    this.scene.background = new THREE.Color(0x111111);

    // Ground Circle
    const groundSize = 20;
    const ground = new THREE.Mesh(
        new THREE.CircleGeometry(groundSize / 2, 64),
        new THREE.MeshStandardMaterial({
            map: this.createCheckerboardTexture(),
            roughness: 0.8,
            metalness: 0.1,
            bumpMap: this.createCheckerboardBumpMap(),
            bumpScale: 0.02,
        })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'Floor';
    this.scene.add(ground);
    this.groundObject = ground;

    // Spheres
    const sphereGeometry = new THREE.SphereGeometry(0.75, 64, 64);

    // Glass Sphere
    const glassMaterial = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(this.glassColor()),
        roughness: this.glassRoughness(),
        metalness: 0,
        transmission: this.glassTransmission(),
        ior: this.glassIor(),
        thickness: 0.5,
    });
    const glassSphere = new THREE.Mesh(sphereGeometry, glassMaterial);
    glassSphere.position.set(-2.5, 0.75, 0);
    glassSphere.castShadow = true;
    glassSphere.name = 'Glass';
    this.scene.add(glassSphere);
    this.sphereObjects.push(glassSphere);
    
    // Matte Sphere
    const matteMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.matteColor()),
        roughness: this.matteRoughness(),
        metalness: this.matteMetalness(),
    });
    const matteSphere = new THREE.Mesh(sphereGeometry, matteMaterial);
    matteSphere.position.set(-0.83, 0.75, 0);
    matteSphere.castShadow = true;
    matteSphere.name = 'Matte';
    this.scene.add(matteSphere);
    this.sphereObjects.push(matteSphere);

    // Chrome Sphere
    const chromeMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.chromeColor()),
        roughness: this.chromeRoughness(),
        metalness: this.chromeMetalness(),
    });
    const chromeSphere = new THREE.Mesh(sphereGeometry, chromeMaterial);
    chromeSphere.position.set(0.83, 0.75, 0);
    chromeSphere.castShadow = true;
    chromeSphere.name = 'Chrome';
    this.scene.add(chromeSphere);
    this.sphereObjects.push(chromeSphere);
    
    // Plastic Sphere
    const plasticMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.plasticColor()),
        roughness: this.plasticRoughness(),
        metalness: this.plasticMetalness(),
    });
    const plasticSphere = new THREE.Mesh(sphereGeometry, plasticMaterial);
    plasticSphere.position.set(2.5, 0.75, 0);
    plasticSphere.castShadow = true;
    plasticSphere.name = 'Plastic';
    this.scene.add(plasticSphere);
    this.sphereObjects.push(plasticSphere);

    // Populate selectable objects array
    this.selectableObjects.push(this.groundObject, ...this.sphereObjects);

    // Color Checker
    this.colorCheckerObject = this.createColorChecker();
    this.scene.add(this.colorCheckerObject);

    // Ambient Light (Basic filler)
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
    this.scene.add(this.ambientLight);
    
    // Note: Manual directional lights are added via setupLightEffects
  }

  private loadHdri(url: string, message: string): void {
    this.isLoading.set(true);
    this.loadingMessage.set(message);
    const loader = new HDRLoader();
    // Ensure we get Float32Array so that sampling logic in addLightAt works correctly
    loader.setDataType(THREE.FloatType); 
    loader.load(url, (texture: THREE.DataTexture) => {
        // Capture original data for tools (Light Editor & Preview)
        const width = texture.image.width;
        const height = texture.image.height;
        const srcData = texture.image.data; // Float32Array

        // Clone data for Light Editor/Preview so they match the original file (L->R)
        this.currentHdriData = new Float32Array(srcData.length);
        this.currentHdriData.set(srcData);
        this.currentHdriWidth = width;
        this.currentHdriHeight = height;
        
        // Generate Preview from original data
        this.generateHdriPreview(this.currentHdriData, width, height);

        const envMap = this.pmremGenerator.fromEquirectangular(texture).texture;
        this.scene.background = envMap;
        this.scene.environment = envMap;

        // Note: currentHdriData is already set above
        
        // Ensure ambient light has a baseline
        this.ambientLight.intensity = 0.2;

        texture.dispose();
        this.isLoading.set(false);
      }, undefined, (error: any) => {
          console.error('An error occurred while loading the HDRI.', error);
          this.loadingMessage.set('Error loading HDRI.');
      }
    );
  }

  private generateHdriPreview(data: Float32Array | any, width: number, height: number): void {
      // Render to a small offscreen canvas
      const canvas = document.createElement('canvas');
      // Limit resolution for performance
      const maxWidth = 512;
      const scale = Math.min(1, maxWidth / width);
      canvas.width = Math.floor(width * scale);
      canvas.height = Math.floor(height * scale);
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      const imgData = ctx.createImageData(canvas.width, canvas.height);
      
      // Simple loop with nearest neighbor sampling
      for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
              // Map canvas pixel to texture pixel
              const tx = Math.floor(x / scale);
              const ty = Math.floor(y / scale);
              
              const srcIdx = (ty * width + tx) * 4; // Assuming 4 channels (RGBE or RGBA) or 3 if RGB
              // HDRLoader usually returns RGB or RGBA float data.
              
              const r = data[srcIdx];
              const g = data[srcIdx + 1];
              const b = data[srcIdx + 2];
              
              // Simple Reinhard Tone Mapping: x / (x + 1) -> Gamma 2.2
              const tm = (c: number) => Math.pow(c / (c + 1), 1 / 2.2) * 255;
              
              const dstIdx = (y * canvas.width + x) * 4;
              imgData.data[dstIdx] = tm(r);
              imgData.data[dstIdx + 1] = tm(g);
              imgData.data[dstIdx + 2] = tm(b);
              imgData.data[dstIdx + 3] = 255;
          }
      }
      
      ctx.putImageData(imgData, 0, 0);
      this.hdriPreviewUrl.set(canvas.toDataURL());
  }
  
  // --- Light Editor Logic ---
  
  private calculateUV(event: MouseEvent, imgElement: HTMLElement): {u: number, v: number} {
      const rect = imgElement.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // Assuming image covers the rect or fits in a known way.
      // With object-fit: cover, the image size might differ from rect size in one dimension.
      // But for simplicity, assuming the img tag fills the container or using a specific calc.
      // Reusing logic from previous robust fix:
      
      const img = imgElement as HTMLImageElement;
      const iw = img.naturalWidth || rect.width; // Fallback if not loaded
      const ih = img.naturalHeight || rect.height;
      const boxW = rect.width;
      const boxH = rect.height;

      // cover = max scale to fill box
      const scale = Math.max(boxW / iw, boxH / ih);
      const drawW = iw * scale;
      const drawH = ih * scale;

      const offX = (boxW - drawW) * 0.5;
      const offY = (boxH - drawH) * 0.5;

      const uRaw = (x - offX) / drawW;
      const vRaw = (y - offY) / drawH;

      const u = Math.min(1, Math.max(0, uRaw));
      const v = Math.min(1, Math.max(0, vRaw));
      
      return { u, v };
  }

  onHdriPreviewClick(event: MouseEvent): void {
      if (!this.currentHdriData) return;
      if (this.isDraggingLight) return; // Ignore click if we just finished dragging

      // Original Add logic
      const { u, v } = this.calculateUV(event, this.hdriPreviewImage.nativeElement);
      
      // Check collision
      const existing = this.manualLights().find(l => {
         const dx = l.u - u;
         const dy = l.v - v;
         return (dx*dx + dy*dy) < 0.002;
      });
      
      if (existing) {
          this.selectedLightId.set(existing.id);
      } else {
          this.addLightAt(u, v);
      }
  }
  
  onLightMarkerMouseDown(event: MouseEvent, id: string): void {
      event.preventDefault();
      event.stopPropagation();
      this.isDraggingLight = true;
      this.selectedLightId.set(id);
  }
  
  onHdriPreviewMouseMove(event: MouseEvent): void {
      if (!this.isDraggingLight) return;
      
      const id = this.selectedLightId();
      if (!id) return;
      
      const { u, v } = this.calculateUV(event, this.hdriPreviewImage.nativeElement);
      this.updateSelectedLight({ u, v });
  }
  
  onHdriPreviewMouseUp(): void {
      this.isDraggingLight = false;
  }
  
  private addLightAt(u: number, v: number): void {
      if (!this.currentHdriData) return;
      
      // Sample HDRI Data
      const x = Math.floor(u * this.currentHdriWidth);
      const y = Math.floor(v * this.currentHdriHeight);
      const idx = (y * this.currentHdriWidth + x) * 4; // Assuming RGBA Float
      
      const r = this.currentHdriData[idx];
      const g = this.currentHdriData[idx + 1];
      const b = this.currentHdriData[idx + 2];
      
      // Extract intensity and color
      const maxVal = Math.max(r, g, b, 0.001);
      const intensity = Math.min(10, maxVal); // Cap auto-intensity to avoid blowing out
      
      // Normalize color
      const color = new THREE.Color(r/maxVal, g/maxVal, b/maxVal);
      
      const newLight: ManualLight = {
          id: MathUtils.generateUUID(),
          u,
          v,
          color: '#' + color.getHexString(),
          intensity: intensity,
          castShadow: true
      };
      
      this.manualLights.update(lights => [...lights, newLight]);
      this.selectedLightId.set(newLight.id);
  }
  
  removeLight(id: string): void {
      const lightToRemove = this.manualLights().find(l => l.id === id);
      if (lightToRemove && lightToRemove.instance) {
          this.scene.remove(lightToRemove.instance);
          this.scene.remove(lightToRemove.instance.target); // Remove target too
          lightToRemove.instance.dispose();
      }
      this.manualLights.update(lights => lights.filter(l => l.id !== id));
      if (this.selectedLightId() === id) {
          this.selectedLightId.set(null);
      }
  }
  
  updateSelectedLight(changes: Partial<ManualLight>): void {
      const id = this.selectedLightId();
      if (!id) return;
      
      this.manualLights.update(lights => lights.map(l => {
          if (l.id === id) {
              return { ...l, ...changes };
          }
          return l;
      }));
  }
  
  getSelectedLight(): ManualLight | undefined {
      return this.manualLights().find(l => l.id === this.selectedLightId());
  }

  // ... (Animation, Resize, ResetView, RenderScene, File Handling logic largely same) ...
  private animate(): void {
    requestAnimationFrame(this.animate.bind(this));
    this.controls.update();

    if (this.renderer && this.scene) {
        // Ensure exposure is applied every frame to prevent it from getting "stuck"
        this.renderer.toneMappingExposure = this.exposure();
    }

    this.renderer.render(this.scene, this.camera);
  }

  private onWindowResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private onObjectClick(event: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Pick Light Mode Logic
    if (this.isPickingLight()) {
        const chromeSphere = this.sphereObjects[2]; // Chrome sphere index
        if (!chromeSphere) return;

        const intersects = this.raycaster.intersectObject(chromeSphere);
        if (intersects.length > 0) {
            const hit = intersects[0];
            const normal = hit.normal!;
            // Calculate View Vector (Camera -> Point)
            const viewDir = new THREE.Vector3().subVectors(hit.point, this.camera.position).normalize();
            
            // Reflect: viewDir (incident) reflects off normal.
            // Result is the direction the light is coming FROM in world space relative to the camera view.
            // Wait, reflect(incident, normal) gives the outgoing vector. 
            // If I look at the sphere, the vector bouncing OFF the sphere towards the sky is the one hitting the skybox pixel.
            const lightDir = new THREE.Vector3().copy(viewDir).reflect(normal).normalize();

            // Undo Global Scene Rotation to get local Texture coordinates
            const envRotation = this.rotation() * Math.PI * 2;
            lightDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), -envRotation);

            // Convert Vector to Spherical Coords
            const spherical = new THREE.Spherical().setFromVector3(lightDir);

            // Convert Spherical to UV
            // Standard Equirectangular mapping:
            // theta [-PI, PI] or [0, 2PI] depending on system. Three.js gives [-PI, PI] usually?
            // phi [0, PI] (0 is Up, PI is Down)
            
            // Reversing my light setup logic:
            // theta = (u - 0.5) * 2 * PI
            // u - 0.5 = theta / 2PI
            // u = (theta / (2 * PI)) + 0.5
            let u = (spherical.theta / (2 * Math.PI)) + 0.5;
            
            // phi = v * PI
            // v = phi / PI
            let v = spherical.phi / Math.PI;

            // Normalize U just in case
            if (u < 0) u += 1;
            if (u > 1) u -= 1;
            
            // Clamp V
            v = Math.max(0.001, Math.min(0.999, v));

            this.addLightAt(u, v);
            this.isPickingLight.set(false); // Turn off after picking
        }
        return;
    }

    // Material Editor Logic
    if (!this.isMaterialEditorOpen()) return;
    const intersects = this.raycaster.intersectObjects(this.selectableObjects);
    if (intersects.length > 0) {
        const clickedObject = intersects[0].object;
        const materialName = clickedObject.name as EditableMaterial;
        if (['Floor', 'Glass', 'Matte', 'Chrome', 'Plastic', 'Color Checker'].includes(materialName)) {
            this.selectedMaterial.set(materialName);
        }
    }
  }

  private highlightObject(object: THREE.Object3D | null): void {
      // ... (Same implementation)
      if (this.highlightTimeoutId) { clearTimeout(this.highlightTimeoutId); this.highlightTimeoutId = null; }
      const unhighlight = (obj: THREE.Object3D) => {
          const objectsToRevert = obj.type === 'Group' ? obj.children : [obj];
          for (const item of objectsToRevert) {
              const material = (item as any).material;
              const originalColor = this.originalEmissiveColors.get(item.uuid);
              if (material && originalColor) material.emissive.copy(originalColor);
              this.originalEmissiveColors.delete(item.uuid);
          }
      };
      if (this.selectedObjectForEditing) unhighlight(this.selectedObjectForEditing);
      this.selectedObjectForEditing = object;
      if (!this.selectedObjectForEditing) return;
      const highlight = (obj: THREE.Object3D) => {
          const objectsToHighlight = obj.type === 'Group' ? obj.children : [obj];
          const highlightColor = new THREE.Color(this.theme() === 'dark' ? '#0ea5e9' : '#0284c7');
          for (const item of objectsToHighlight) {
              const material = (item as any).material;
              if (material) {
                  this.originalEmissiveColors.set(item.uuid, material.emissive.clone());
                  material.emissive.copy(highlightColor);
              }
          }
      };
      highlight(this.selectedObjectForEditing);
      const objectToUnhighlight = this.selectedObjectForEditing;
      this.highlightTimeoutId = setTimeout(() => {
          if (this.selectedObjectForEditing === objectToUnhighlight) {
              unhighlight(objectToUnhighlight);
              this.selectedObjectForEditing = null; 
          }
          this.highlightTimeoutId = null;
      }, 1500);
  }

  resetView(): void {
    if (this.camera && this.controls) {
      this.camera.position.set(0, 1.5, 8);
      this.controls.target.set(0, 1, 0);
      this.controls.update();
    }
  }

  renderScene(): void {
    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.renderer.domElement.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    const hdriName = this.selectedHdriName()?.replace(/\.(hdr|pic)$/i, '') || 'scene';
    link.download = `${hdriName}-render.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  onDragOver(event: DragEvent) { event.preventDefault(); event.stopPropagation(); }
  onDrop(event: DragEvent) {
    event.preventDefault(); event.stopPropagation();
    if (!event.dataTransfer?.files) return;
    this.handleFiles(event.dataTransfer.files);
  }
  onHdriUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;
    this.handleFiles(input.files);
    input.value = '';
  }

  private handleFiles(files: FileList): void {
    const newHdris: HDRI[] = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file && (file.name.endsWith('.hdr') || file.name.endsWith('.pic'))) {
            const url = URL.createObjectURL(file);
            newHdris.push({ name: file.name, url, file, lights: [] });
        }
    }
    if (newHdris.length > 0) {
      this.hdriList.update(currentList => {
        const newNames = new Set(newHdris.map(h => h.name));
        const filteredList = currentList.filter(h => !newNames.has(h.name));
        return [...filteredList, ...newHdris];
      });
      // Switch to the first new HDRI
      this.switchHdri(newHdris[0].name);
    }
  }

  // --- Logic to switch HDRI and Lights ---
  switchHdri(newHdriName: string): void {
      const currentName = this.selectedHdriName();
      
      // 1. Save current lights to the *current* HDRI in the list before switching
      if (currentName) {
          const currentLights = this.manualLights();
          this.hdriList.update(list => list.map(h => {
              if (h.name === currentName) {
                  return { ...h, lights: currentLights };
              }
              return h;
          }));
      }

      // 2. Clear existing physical lights from the scene to prevent ghosting
      // The effect `setupLightEffects` adds lights, but we need to ensure old ones are gone.
      this.manualLights().forEach(l => {
          if (l.instance) {
              this.scene.remove(l.instance);
              this.scene.remove(l.instance.target);
              l.instance.dispose();
              // Remove references
              l.instance = undefined;
          }
      });
      this.selectedLightId.set(null);

      // 3. Find the new HDRI and load its lights
      const nextHdri = this.hdriList().find(h => h.name === newHdriName);
      // Copy lights deeply to avoid reference issues, or map them to new objects if needed.
      // For now, shallow copy of array + ref sharing of objects is okay as long as we don't mutate shared objects across HDRIs unexpectedly.
      // But `instance` (THREE.Light) should be regenerated.
      const nextLights = nextHdri?.lights.map(l => ({...l, instance: undefined})) || [];
      
      this.manualLights.set(nextLights);
      this.selectedHdriName.set(newHdriName);
  }

  toggleAllObjects(): void {
    const shouldShow = !this.anyObjectVisible();
    this.spheresVisible.set(shouldShow);
    this.colorCheckerVisible.set(shouldShow);
    this.groundVisible.set(shouldShow);
    this.currentPreset.set('Custom');
  }

  nextPreset(): void {
    const currentIndex = this.presets.indexOf(this.currentPreset());
    const nextIndex = (currentIndex + 1) % this.presets.length;
    this.currentPreset.set(this.presets[nextIndex]);
  }

  previousPreset(): void {
    const currentIndex = this.presets.indexOf(this.currentPreset());
    const prevIndex = (currentIndex - 1 + this.presets.length) % this.presets.length;
    this.currentPreset.set(this.presets[prevIndex]);
  }
  
  private applyPreset(preset: Preset): void {
    if (preset !== 'Custom') {
        this.customPresetName.set(null);
        this.loadedPresetData.set(null);
    }
    switch(preset) {
        case 'SHV': this.applyShvPreset(); break;
        case 'Polyhaven': this.applyPolyhavenPreset(); break;
        case 'Grayscale': this.applyGrayscalePreset(); break;
        case 'SkinTone': this.applySkinTonePreset(); break;
        case 'Custom': break;
    }
  }

  // ... (Reset materials, Apply Presets logic same as before) ...
  private resetMaterialsToDefault(): void {
    this.glassColor.set('#ffffff'); this.glassRoughness.set(0); this.glassIor.set(1.5); this.glassTransmission.set(1);
    this.matteColor.set('#ffffff'); this.matteRoughness.set(1); this.matteMetalness.set(0);
    this.chromeColor.set('#ffffff'); this.chromeRoughness.set(0); this.chromeMetalness.set(1);
    this.plasticColor.set('#00bcd4'); this.plasticRoughness.set(0.1); this.plasticMetalness.set(0.05);
    this.resetColorChecker();
  }
  private setColorCheckerRowsVisibility(visible: boolean, visibleRows: number[] = [0, 1, 2, 3]): void {
    if (this.colorCheckerPatches.length === 0) return;
    this.colorCheckerPatches.forEach((rowPatches, rowIndex) => {
        const rowVisible = visible && visibleRows.includes(rowIndex);
        rowPatches.forEach(patch => patch.visible = rowVisible);
    });
  }
  private applyShvPreset(): void {
    this.resetMaterialsToDefault();
    this.plasticColor.set('#353535');
    this.spheresVisible.set(true); this.colorCheckerVisible.set(true); this.groundVisible.set(true);
    this.setColorCheckerRowsVisibility(true, [0, 1, 2, 3]);
  }
  private applyPolyhavenPreset(): void {
    this.resetMaterialsToDefault();
    this.spheresVisible.set(true); this.colorCheckerVisible.set(false); this.groundVisible.set(true);
  }
  private applyGrayscalePreset(): void {
    this.spheresVisible.set(true); this.colorCheckerVisible.set(true); this.groundVisible.set(false);
    this.setColorCheckerRowsVisibility(true, [3]);
    const roughness = 0.30; const metalness = 0.05;
    const colors = ['#525252', '#757575', '#A3A3A3', '#DBDBDB'];
    this.glassTransmission.set(0); this.glassColor.set(colors[3]); this.glassRoughness.set(roughness); this.glassIor.set(1.5);
    this.matteColor.set(colors[2]); this.matteRoughness.set(roughness); this.matteMetalness.set(metalness);
    this.chromeColor.set(colors[1]); this.chromeRoughness.set(roughness); this.chromeMetalness.set(metalness);
    this.plasticColor.set(colors[0]); this.plasticRoughness.set(roughness); this.plasticMetalness.set(metalness);
  }
  private applySkinTonePreset(): void {
    this.spheresVisible.set(true); this.colorCheckerVisible.set(false); this.groundVisible.set(true);
    const roughness = 0.5; const metalness = 0;
    const colors = ['#F2D5B8', '#E0A98E', '#9E6E55', '#6E4A36'];
    this.glassTransmission.set(0); this.glassColor.set(colors[0]); this.glassRoughness.set(roughness); this.glassIor.set(1.4);
    this.matteColor.set(colors[1]); this.matteRoughness.set(roughness); this.matteMetalness.set(metalness);
    this.chromeColor.set(colors[2]); this.chromeRoughness.set(roughness); this.chromeMetalness.set(metalness);
    this.plasticColor.set(colors[3]); this.plasticRoughness.set(roughness); this.plasticMetalness.set(metalness);
  }

  // --- Restored Missing Methods ---

  updateColorCheckerColor(row: number, col: number, color: string): void {
    const patch = this.colorCheckerPatches[row]?.[col];
    if (patch) {
        (patch.material as THREE.MeshStandardMaterial).color.set(color);
        this.colorCheckerColors.update(colors => {
            colors[row][col] = color;
            return [...colors.map(r => [...r])]; 
        });
        this.currentPreset.set('Custom');
    }
  }

  async loadDemoScene(): Promise<void> {
    this.isLoading.set(true);
    this.loadingMessage.set('Loading Demo Scene...');
    try {
      const demoHdriUrl = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr';
      const response = await fetch(demoHdriUrl);
      if (!response.ok) throw new Error(`Failed to fetch demo HDRI: ${response.statusText}`);
      const blob = await response.blob();
      const file = new File([blob], "studio_small_09_1k.hdr", { type: 'image/vnd.radiance' });
      const url = URL.createObjectURL(file);
      // Demo scene starts with no manual lights
      const demoHdri: HDRI = { name: 'Studio Small 09 Demo', url, file, lights: [] };
      this.hdriList().forEach(hdri => URL.revokeObjectURL(hdri.url));
      
      this.hdriList.set([demoHdri]);
      this.currentPreset.set('SHV'); 
      this.applyShvPreset(); 
      this.rotation.set(0);
      this.exposure.set(1);
      this.blur.set(0);
      this.toneMapping.set('Reinhard');
      this.colorSpace.set('ACES Filmic');
      this.spheresVisible.set(true);
      this.groundVisible.set(true);
      this.colorCheckerVisible.set(true);
      
      // Clear all existing lights properly
      this.manualLights().forEach(l => {
          if (l.instance) {
              this.scene.remove(l.instance);
              this.scene.remove(l.instance.target);
              l.instance.dispose();
          }
      });
      this.manualLights.set([]); // Reset lights for demo
      
      // Clean generic scene lights if any leftover (safety)
      this.scene.children.filter(c => c instanceof THREE.DirectionalLight).forEach(l => {
          this.scene.remove(l);
          (l as THREE.DirectionalLight).dispose();
      });
      
      this.selectedHdriName.set(demoHdri.name);

    } catch (error) {
      console.error('Failed to load demo scene:', error);
      this.loadingMessage.set('Error: Could not load demo scene.');
      setTimeout(() => this.isLoading.set(false), 3000);
    }
    this.isLoading.set(false);
  }

  onColorSpaceChange(value: ColorSpaceOption): void {
    this.colorSpace.set(value);
    if (value === 'Linear sRGB') {
      this.toneMapping.set('None');
    }
  }

  onFloorTextureUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    this.loadAndApplyFloorTexture(file);
    input.value = '';
  }

  resetFloorTexture(): void { this.restoreDefaultFloorTexture(); }

  onGlassRoughnessUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadAndApplyRoughnessTexture(input.files[0], 0, this.glassRoughnessTextureFile);
    input.value = '';
  }
  resetGlassRoughnessTexture(): void { this.removeRoughnessTexture(0, this.glassRoughnessTextureFile); }

  onMatteRoughnessUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadAndApplyRoughnessTexture(input.files[0], 1, this.matteRoughnessTextureFile);
    input.value = '';
  }
  resetMatteRoughnessTexture(): void { this.removeRoughnessTexture(1, this.matteRoughnessTextureFile); }

  onChromeRoughnessUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadAndApplyRoughnessTexture(input.files[0], 2, this.chromeRoughnessTextureFile);
    input.value = '';
  }
  resetChromeRoughnessTexture(): void { this.removeRoughnessTexture(2, this.chromeRoughnessTextureFile); }

  onPlasticRoughnessUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadAndApplyRoughnessTexture(input.files[0], 3, this.plasticRoughnessTextureFile);
    input.value = '';
  }
  resetPlasticRoughnessTexture(): void { this.removeRoughnessTexture(3, this.plasticRoughnessTextureFile); }

  async savePreset(): Promise<void> {
    const presetData: CustomPresetData = {
        version: '1.0',
        materials: {
            glass: { color: this.glassColor(), roughness: this.glassRoughness(), ior: this.glassIor(), transmission: this.glassTransmission() },
            matte: { color: this.matteColor(), roughness: this.matteRoughness(), metalness: this.matteMetalness() },
            chrome: { color: this.chromeColor(), roughness: this.chromeRoughness(), metalness: this.chromeMetalness() },
            plastic: { color: this.plasticColor(), roughness: this.plasticRoughness(), metalness: this.plasticMetalness() },
        },
        visibility: {
            spheres: this.spheresVisible(),
            colorChecker: this.colorCheckerVisible(),
            ground: this.groundVisible(),
        },
        colorChecker: {
            colors: this.colorCheckerColors(),
        }
    };
    const jsonString = JSON.stringify(presetData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'custom-preset.shvpreset';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  onPresetLoad(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const result = e.target?.result as string;
            const data: CustomPresetData = JSON.parse(result);
            if (data.version !== '1.0' || !data.materials || !data.visibility) throw new Error('Invalid preset file format.');
            this.glassColor.set(data.materials.glass.color); this.glassRoughness.set(data.materials.glass.roughness); this.glassIor.set(data.materials.glass.ior); this.glassTransmission.set(data.materials.glass.transmission);
            this.matteColor.set(data.materials.matte.color); this.matteRoughness.set(data.materials.matte.roughness); this.matteMetalness.set(data.materials.matte.metalness);
            this.chromeColor.set(data.materials.chrome.color); this.chromeRoughness.set(data.materials.chrome.roughness); this.chromeMetalness.set(data.materials.chrome.metalness);
            this.plasticColor.set(data.materials.plastic.color); this.plasticRoughness.set(data.materials.plastic.roughness); this.plasticMetalness.set(data.materials.plastic.metalness);
            this.spheresVisible.set(data.visibility.spheres); this.colorCheckerVisible.set(data.visibility.colorChecker); this.groundVisible.set(data.visibility.ground);
            if (data.colorChecker && data.colorChecker.colors) {
                this.colorCheckerColors.set(data.colorChecker.colors);
                for (let row = 0; row < data.colorChecker.colors.length; row++) {
                    for (let col = 0; col < data.colorChecker.colors[row].length; col++) {
                        const patch = this.colorCheckerPatches[row]?.[col];
                        if (patch) (patch.material as THREE.MeshStandardMaterial).color.set(data.colorChecker.colors[row][col]);
                    }
                }
            }
            this.currentPreset.set('Custom');
            this.customPresetName.set(file.name.replace(/\.shvpreset$/i, ''));
            this.loadedPresetData.set(data); // Store for saving in project
        } catch (error) { console.error('Failed to load preset:', error); alert('Failed to load preset.'); }
    };
    reader.onerror = () => { alert('Error reading preset file.'); }
    reader.readAsText(file);
    input.value = '';
  }
  
  resetColorChecker(): void {
    if (!this.colorCheckerPatches.length) return;
    const initialColors: string[][] = [];
    for (let i = 0; i < this.defaultColorCheckerColors.length; i++) {
        const row = Math.floor(i / 6);
        const col = i % 6;
        const colorValues = this.defaultColorCheckerColors[i];
        const color = new THREE.Color().setRGB(colorValues[0] / 255, colorValues[1] / 255, colorValues[2] / 255);
        if (!initialColors[row]) initialColors[row] = [];
        initialColors[row][col] = '#' + color.getHexString();
        
        const patch = this.colorCheckerPatches[row]?.[col];
        if (patch) {
            (patch.material as THREE.MeshStandardMaterial).color.copy(color);
        }
    }
    this.colorCheckerColors.set(initialColors);
  }

  loadAndApplyFloorTexture(file: File): void {
      const url = URL.createObjectURL(file);
      this.textureLoader.load(url, (texture) => {
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(this.floorTiling(), this.floorTiling());
          texture.colorSpace = THREE.SRGBColorSpace;
          
          if (this.groundObject && this.groundObject.material) {
              const mat = this.groundObject.material as THREE.MeshStandardMaterial;
              mat.map = texture;
              mat.needsUpdate = true;
          }
          this.floorTextureFile.set(file);
      });
  }

  restoreDefaultFloorTexture(): void {
      if (this.groundObject && this.groundObject.material) {
          const mat = this.groundObject.material as THREE.MeshStandardMaterial;
          mat.map = this.createCheckerboardTexture();
          mat.needsUpdate = true;
      }
      this.floorTextureFile.set(null);
  }
  
  loadAndApplyRoughnessTexture(file: File, sphereIndex: number, signalSetter: WritableSignal<File | null>): void {
      const url = URL.createObjectURL(file);
      this.textureLoader.load(url, (texture) => {
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          
          const sphere = this.sphereObjects[sphereIndex];
          if (sphere && sphere.material) {
              const mat = sphere.material as THREE.MeshStandardMaterial;
              mat.roughnessMap = texture;
              mat.needsUpdate = true;
          }
          signalSetter.set(file);
      });
  }
  
  removeRoughnessTexture(sphereIndex: number, signalSetter: WritableSignal<File | null>): void {
      const sphere = this.sphereObjects[sphereIndex];
      if (sphere && sphere.material) {
          const mat = sphere.material as THREE.MeshStandardMaterial;
          mat.roughnessMap = null;
          mat.needsUpdate = true;
      }
      signalSetter.set(null);
  }

  toggleTheme(): void { this.theme.update(current => current === 'dark' ? 'light' : 'dark'); }

  // Helper method implementation
  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = error => reject(error);
    });
  }

  // Helper to encrypt file to data object (V1.7 Envelope)
  private async fileToEncryptedData(file: File): Promise<TextureData> {
      const { data, iv, wrappedKey, keyIv } = await this.cryptoService.encryptBlobEnvelope(file);
      return { name: file.name, data, encrypted: true, iv, wrappedKey, keyIv };
  }

  // Helper for normal base64 (Legacy)
  private async fileToTextureData(file: File): Promise<TextureData> {
      return { name: file.name, data: await this.fileToBase64(file) };
  }
  
  private async loadTextureData(
    textureData: TextureData | null | undefined, 
    sphereIndex: number, 
    signalSetter: WritableSignal<File | null>
  ): Promise<void> {
      if (!textureData) {
          if (sphereIndex === -1) {
              this.restoreDefaultFloorTexture();
          } else {
              this.removeRoughnessTexture(sphereIndex, signalSetter);
          }
          return;
      }

      try {
          let blob: Blob;
          // Check for V1.7 Envelope Encryption
          if (textureData.encrypted && textureData.iv && textureData.wrappedKey && textureData.keyIv) {
             blob = await this.cryptoService.decryptBlobEnvelope(
                 textureData.data, 
                 textureData.iv, 
                 textureData.wrappedKey, 
                 textureData.keyIv, 
                 'image/png' // Assuming standard image type
             );
          } else if (textureData.encrypted) {
              console.warn('Legacy V1.6 texture encryption not supported for automatic loading.');
              return;
          } else {
              // Legacy Base64
              blob = this.base64ToBlob(textureData.data);
          }
          
          const file = new File([blob], textureData.name, { type: blob.type || 'image/png' });
          
          // Reuse existing apply logic
          if (sphereIndex === -1) {
              this.loadAndApplyFloorTexture(file);
          } else {
              this.loadAndApplyRoughnessTexture(file, sphereIndex, signalSetter);
          }
      } catch (e) {
          console.error('Failed to load texture', textureData.name, e);
      }
  }

  async saveProject(): Promise<void> {
    this.isLoading.set(true);
    this.loadingMessage.set('Saving secure project (V1.7)...');
    try {
        // Ensure current lights are synced to current HDRI before saving
        const currentName = this.selectedHdriName();
        const currentLights = this.manualLights().map(l => ({
            id: l.id,
            u: l.u, v: l.v, color: l.color, intensity: l.intensity, castShadow: l.castShadow
        }));
        
        // 1. Process HDRIs: Encrypt them using Envelope Encryption
        const hdriDataPromises = this.hdriList().map(async (hdri) => {
            const lightsToSave = (hdri.name === currentName) 
                ? currentLights 
                : hdri.lights.map(l => ({ id: l.id, u: l.u, v: l.v, color: l.color, intensity: l.intensity, castShadow: l.castShadow }));

            let blob: Blob;
            if (!hdri.file) {
                const response = await fetch(hdri.url);
                blob = await response.blob();
            } else {
                blob = hdri.file;
            }
            
            // Encrypt Blob with Envelope via Service
            const { data, iv, wrappedKey, keyIv } = await this.cryptoService.encryptBlobEnvelope(blob);
            
            return { 
                name: hdri.name, 
                data, // Encrypted Base64
                encrypted: true,
                iv,
                wrappedKey,
                keyIv,
                lights: lightsToSave 
            };
        });

        // 2. Process Textures: Encrypt them as well
        const [
            resolvedHdriData, 
            floorTexture, glassRoughnessTexture, matteRoughnessTexture, chromeRoughnessTexture, plasticRoughnessTexture
        ] = await Promise.all([
            Promise.all(hdriDataPromises),
            this.floorTextureFile() ? this.fileToEncryptedData(this.floorTextureFile()!) : Promise.resolve(null),
            this.glassRoughnessTextureFile() ? this.fileToEncryptedData(this.glassRoughnessTextureFile()!) : Promise.resolve(null),
            this.matteRoughnessTextureFile() ? this.fileToEncryptedData(this.matteRoughnessTextureFile()!) : Promise.resolve(null),
            this.chromeRoughnessTextureFile() ? this.fileToEncryptedData(this.chromeRoughnessTextureFile()!) : Promise.resolve(null),
            this.plasticRoughnessTextureFile() ? this.fileToEncryptedData(this.plasticRoughnessTextureFile()!) : Promise.resolve(null)
        ]);

        const project: ProjectDataV1_7 = {
            version: '1.7',
            settings: {
                rotation: this.rotation(),
                exposure: this.exposure(),
                blur: this.blur(),
                selectedHdriName: this.selectedHdriName(),
                toneMapping: this.toneMapping(),
                spheresVisible: this.spheresVisible(),
                groundVisible: this.groundVisible(),
                colorCheckerVisible: this.colorCheckerVisible(),
                colorSpace: this.colorSpace()
            },
            materials: {
                floor: { tiling: this.floorTiling(), texture: floorTexture },
                glass: { roughness: this.glassRoughness(), ior: this.glassIor(), roughnessTexture: glassRoughnessTexture },
                matte: { color: this.matteColor(), roughness: this.matteRoughness(), metalness: this.matteMetalness(), roughnessTexture: matteRoughnessTexture },
                chrome: { color: this.chromeColor(), roughness: this.chromeRoughness(), metalness: this.chromeMetalness(), roughnessTexture: chromeRoughnessTexture },
                plastic: { color: this.plasticColor(), roughness: this.plasticRoughness(), metalness: this.plasticMetalness(), roughnessTexture: plasticRoughnessTexture },
                colorChecker: { colors: this.colorCheckerColors().flat() }
            },
            hdris: resolvedHdriData as any[], // Cast to allow encrypted properties
            loadedPreset: this.loadedPresetData() ? {
                name: this.customPresetName() || 'Custom',
                data: this.loadedPresetData()!
            } : undefined
        };

        const jsonString = JSON.stringify(project);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `project_${Date.now()}.hdriv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (error) {
        console.error('Failed to save project:', error);
        alert('Failed to save project.');
    } finally {
        this.isLoading.set(false);
    }
  }

  onProjectLoad(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
        try {
            const result = e.target?.result as string;
            const project: AnyProjectData = JSON.parse(result);
            if (!project.version || !project.hdris || !project.settings) throw new Error('Invalid project file format.');
            
            this.isLoading.set(true);
            this.loadingMessage.set('Decrypting and loading project...');

            // Clear existing data
            this.hdriList().forEach(hdri => URL.revokeObjectURL(hdri.url));
            
            // Clear actual scene lights
            this.manualLights().forEach(l => {
                if (l.instance) {
                    this.scene.remove(l.instance);
                    this.scene.remove(l.instance.target);
                    l.instance.dispose();
                }
            });
            this.manualLights.set([]); 
            this.scene.children.filter(c => c instanceof THREE.DirectionalLight).forEach(l => {
                this.scene.remove(l);
                (l as THREE.DirectionalLight).dispose();
            });

            // --- Load HDRIs (Handling V1.7 Decryption) ---
            const loadedHdris: HDRI[] = [];
            for (const hdriData of project.hdris) {
                let blob: Blob;
                
                // Check if encrypted (V1.7)
                if ('encrypted' in hdriData && hdriData.encrypted && 'iv' in hdriData && 'wrappedKey' in hdriData && 'keyIv' in hdriData) {
                    try {
                        blob = await this.cryptoService.decryptBlobEnvelope(hdriData.data, hdriData.iv, hdriData.wrappedKey, hdriData.keyIv, 'image/vnd.radiance');
                    } catch (err) {
                        console.error("Decryption failed for HDRI", hdriData.name);
                        alert(`Could not decrypt HDRI: ${hdriData.name}. The project key may not match or file is corrupted.`);
                        continue;
                    }
                } else if ('encrypted' in hdriData && hdriData.encrypted) {
                     alert(`Legacy V1.6 Encrypted file detected. This version only supports V1.7 Envelope Encryption.`);
                     continue;
                } else {
                    // Legacy Base64
                    blob = this.base64ToBlob(hdriData.data);
                }

                const file = new File([blob], hdriData.name, {type: blob.type});
                
                // Load lights based on version
                let lights: ManualLight[] = [];
                if (['1.5', '1.6', '1.7'].includes(project.version)) {
                    const pHdri = hdriData as { lights: ManualLight[] };
                    if (pHdri.lights) {
                         lights = pHdri.lights.map(l => ({
                            id: MathUtils.generateUUID(),
                            u: l.u, v: l.v, color: l.color, intensity: l.intensity, castShadow: l.castShadow
                        }));
                    }
                } 
                
                loadedHdris.push({ name: hdriData.name, url: URL.createObjectURL(blob), file: file, lights: lights });
            }

            this.hdriList.set(loadedHdris);
            
            // --- NEW: Load Custom Preset Data if V1.7 ---
            if (project.version === '1.7' && (project as ProjectDataV1_7).loadedPreset) {
                const p = (project as ProjectDataV1_7).loadedPreset!;
                this.loadedPresetData.set(p.data);
                this.customPresetName.set(p.name);
                this.currentPreset.set('Custom');
            } else {
                this.currentPreset.set('SHV');
            }
            
            const settings = project.settings;
            this.rotation.set(settings.rotation);
            this.exposure.set(settings.exposure);
            this.blur.set(settings.blur);
            
            if ('colorSpace' in settings && (settings as any).colorSpace) {
                const loadedColorSpace = (settings as any).colorSpace;
                this.colorSpace.set(loadedColorSpace === 'ACEScg' || loadedColorSpace === 'ACES Filmic' ? 'ACES Filmic' : 'Linear sRGB');
            } else {
                this.colorSpace.set((settings as any).toneMapping === 'ACES Filmic' ? 'ACES Filmic' : 'ACES Filmic');
            }
            if (settings.toneMapping && (settings as any).toneMapping !== 'ACES Filmic') {
                 if ((settings.toneMapping as any) === 'Linear' || (settings.toneMapping as any) === 'None (sRGB)') {
                    this.toneMapping.set('None');
                } else if (['Reinhard', 'Cineon', 'None', 'Grayscale'].includes(settings.toneMapping)) {
                    this.toneMapping.set(settings.toneMapping as any);
                } else {
                    this.toneMapping.set('Reinhard');
                }
            } else {
                this.toneMapping.set('Reinhard');
            }

            // Restore Global lights for legacy V1.4
            if (project.version === '1.4' && settings.selectedHdriName) {
                const p = project as ProjectDataV1_4;
                const restoredLights: ManualLight[] = p.lights.map(l => ({
                    id: MathUtils.generateUUID(),
                    u: l.u, v: l.v, color: l.color, intensity: l.intensity, castShadow: l.castShadow
                }));
                this.hdriList.update(list => list.map(h => {
                    if (h.name === settings.selectedHdriName) { return { ...h, lights: restoredLights }; }
                    return h;
                }));
                this.manualLights.set(restoredLights);
            } else if (['1.5', '1.6', '1.7'].includes(project.version) && settings.selectedHdriName) {
                const selected = loadedHdris.find(h => h.name === settings.selectedHdriName);
                if (selected) {
                    this.manualLights.set(selected.lights);
                }
            }
            
            // Common Settings & Materials for >= 1.1
            if (['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7'].includes(project.version)) {
                this.spheresVisible.set(project.settings.spheresVisible);
                this.groundVisible.set(project.settings.groundVisible);
                this.colorCheckerVisible.set(project.settings.colorCheckerVisible);

                // Need to cast to any to access materials easily across versions or use specific interfaces
                const materials = (project as any).materials;
                
                this.floorTiling.set(materials.floor.tiling);
                // Async Load Texture (V1.7 Encrypted or Legacy)
                await this.loadTextureData(materials.floor.texture, -1, this.floorTextureFile);

                this.glassRoughness.set(materials.glass.roughness);
                this.glassIor.set(materials.glass.ior);
                this.matteColor.set(materials.matte.color);
                this.matteRoughness.set(materials.matte.roughness);
                this.matteMetalness.set(materials.matte.metalness);
                this.chromeColor.set(materials.chrome.color);
                this.chromeRoughness.set(materials.chrome.roughness);
                this.chromeMetalness.set(materials.chrome.metalness);
                
                // Async Load Texture
                await this.loadTextureData(materials.chrome.roughnessTexture, 2, this.chromeRoughnessTextureFile);

                this.plasticColor.set(materials.plastic.color);
                this.plasticRoughness.set(materials.plastic.roughness);
                this.plasticMetalness.set(materials.plastic.metalness);
                
                // V1.2+ textures
                if (['1.2', '1.3', '1.4', '1.5', '1.6', '1.7'].includes(project.version)) {
                    await this.loadTextureData(materials.glass.roughnessTexture, 0, this.glassRoughnessTextureFile);
                    await this.loadTextureData(materials.matte.roughnessTexture, 1, this.matteRoughnessTextureFile);
                    await this.loadTextureData(materials.plastic.roughnessTexture, 3, this.plasticRoughnessTextureFile);
                } else {
                    this.removeRoughnessTexture(0, this.glassRoughnessTextureFile);
                    this.removeRoughnessTexture(1, this.matteRoughnessTextureFile);
                    this.removeRoughnessTexture(3, this.plasticRoughnessTextureFile);
                }
            }

            // V1.3+ Color checker
             if (['1.3', '1.4', '1.5', '1.6', '1.7'].includes(project.version) && (project as any).materials.colorChecker) {
                const loadedColors = (project as any).materials.colorChecker!.colors;
                const newColorsSignal: string[][] = [];
                for (let i = 0; i < loadedColors.length; i++) {
                    const row = Math.floor(i / 6);
                    const col = i % 6;
                    if (!newColorsSignal[row]) newColorsSignal[row] = [];
                    newColorsSignal[row][col] = loadedColors[i];
                    const patch = this.colorCheckerPatches[row]?.[col];
                    if (patch) (patch.material as THREE.MeshStandardMaterial).color.set(loadedColors[i]);
                }
                this.colorCheckerColors.set(newColorsSignal);
            } else { this.resetColorChecker(); }

            // V1.0 Fallback
            if (project.version === '1.0') {
                this.spheresVisible.set(true); this.groundVisible.set(true);
                this.colorCheckerVisible.set(true);
                this.floorTiling.set(40);
                this.restoreDefaultFloorTexture();
                this.glassRoughness.set(0); this.glassIor.set(1.5);
                this.matteColor.set('#ffffff'); this.matteRoughness.set(1); this.matteMetalness.set(0);
                this.chromeColor.set('#ffffff'); this.chromeRoughness.set(0); this.chromeMetalness.set(1);
                this.removeRoughnessTexture(2, this.chromeRoughnessTextureFile);
                this.plasticColor.set('#00bcd4'); this.plasticRoughness.set(0.1); this.plasticMetalness.set(0.05);
            }

            this.selectedHdriName.set(project.settings.selectedHdriName);
            this.isLoading.set(false);

        } catch (error) {
            console.error('Failed to load project:', error);
            alert('Failed to load project. The file may be corrupt, encrypted with a different key, or in the wrong format.');
            this.isLoading.set(false);
        }
    };
    reader.onerror = () => { alert('Error reading project file.'); this.isLoading.set(false); }
    reader.readAsText(file);
    input.value = '';
  }

  private base64ToBlob(base64: string): Blob {
    const parts = base64.split(';base64,');
    const contentType = parts[0].split(':')[1];
    const raw = window.atob(parts[1]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);
    for (let i = 0; i < rawLength; ++i) { uInt8Array[i] = raw.charCodeAt(i); }
    return new Blob([uInt8Array], { type: contentType });
  }
}
