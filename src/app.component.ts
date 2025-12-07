import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, signal, effect, AfterViewInit, WritableSignal, inject, Injector, runInInjectionContext, computed } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

interface HDRI {
  name: string;
  url: string; // Object URL
  file?: File; // Original file, needed for saving
}

type ToneMappingOption = 'ACES Filmic' | 'Reinhard' | 'Cineon' | 'None';
type EditableMaterial = 'Floor' | 'Glass' | 'Matte' | 'Chrome' | 'Plastic';
type Preset = 'SHV' | 'Polyhaven' | 'Grayscale' | 'SkinTone';
type Theme = 'light' | 'dark';

// --- Project Data Interfaces for Saving/Loading ---
interface TextureData {
  name: string;
  data: string; // base64 string
}

interface ProjectDataV1_2 {
  version: '1.2';
  settings: {
    rotation: number;
    exposure: number;
    blur: number;
    selectedHdriName: string | null;
    toneMapping: ToneMappingOption;
    spheresVisible: boolean;
    groundVisible: boolean;
    shadowsVisible: boolean;
    colorCheckerVisible: boolean;
  };
  materials: {
    floor: {
      tiling: number;
      texture: TextureData | null;
    };
    glass: {
      roughness: number;
      ior: number;
      roughnessTexture: TextureData | null;
    };
    matte: {
      color: string;
      roughness: number;
      metalness: number;
      roughnessTexture: TextureData | null;
    };
    chrome: {
      color: string;
      roughness: number;
      metalness: number;
      roughnessTexture: TextureData | null;
    };
    plastic: {
      color: string;
      roughness: number;
      metalness: number;
      roughnessTexture: TextureData | null;
    };
  };
  hdris: { name: string; data: string }[];
}


interface ProjectDataV1_1 {
  version: '1.1';
  settings: {
    rotation: number;
    exposure: number;
    blur: number;
    selectedHdriName: string | null;
    toneMapping: ToneMappingOption;
    spheresVisible: boolean;
    groundVisible: boolean;
    shadowsVisible: boolean;
    colorCheckerVisible: boolean;
  };
  materials: {
    floor: {
      tiling: number;
      texture: TextureData | null;
    };
    glass: {
      roughness: number;
      ior: number;
    };
    matte: {
      color: string;
      roughness: number;
      metalness: number;
    };
    chrome: {
      color: string;
      roughness: number;
      metalness: number;
      roughnessTexture: TextureData | null;
    };
    plastic: {
      color: string;
      roughness: number;
      metalness: number;
    };
  };
  hdris: { name: string; data: string }[];
}

// For backwards compatibility checking
interface ProjectDataV1_0 {
  version: '1.0';
  settings: {
    rotation: number;
    exposure: number;
    blur: number;
    selectedHdriName: string | null;
    toneMapping: ToneMappingOption;
  };
  hdris: { name: string; data: string }[];
}

type AnyProjectData = ProjectDataV1_2 | ProjectDataV1_1 | ProjectDataV1_0;


@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgOptimizedImage]
})
export class AppComponent implements AfterViewInit {
  @ViewChild('rendererCanvas', { static: true })
  rendererCanvas!: ElementRef<HTMLCanvasElement>;

  // UI State Signals
  rotation = signal(0);
  exposure = signal(1);
  blur = signal(0);
  isLoading = signal(true);
  loadingMessage = signal('Initializing Scene...');
  spheresVisible = signal(true);
  groundVisible = signal(true);
  shadowsVisible = signal(true);
  colorCheckerVisible = signal(true);
  toneMapping = signal<ToneMappingOption>('ACES Filmic');
  anyObjectVisible = computed(() => this.spheresVisible() || this.colorCheckerVisible() || this.groundVisible());
  isMaterialEditorOpen = signal(false);
  isAboutPanelOpen = signal(false);
  aboutPanelActiveTab = signal<'about' | 'how-to' | 'changelog'>('about');

  // HDRI Management Signals
  hdriList: WritableSignal<HDRI[]> = signal([]);
  selectedHdriName = signal<string | null>(null);

  // Preset Management
  presets: Preset[] = ['SHV', 'Polyhaven', 'Grayscale', 'SkinTone'];
  currentPreset = signal<Preset>('SHV');

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
  private directionalLight!: THREE.DirectionalLight;
  private ambientLight!: THREE.AmbientLight;
  private initialLightDirection = new THREE.Vector3();
  private groundObject!: THREE.Mesh;
  private sphereObjects: THREE.Mesh[] = [];
  private colorCheckerObject!: THREE.Group;
  private colorCheckerPatches: THREE.Mesh[][] = [];
  private textureLoader = new THREE.TextureLoader();
  
  private injector = inject(Injector);

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
  }

  ngAfterViewInit(): void {
    this.initThree();
    this.createSceneContent();
    this.animate();
    this.setupSceneUpdateEffects();
    this.setupMaterialUpdateEffects();
    this.setupPresetEffect();
    this.isLoading.set(false);
  }

  private setupSceneUpdateEffects(): void {
    runInInjectionContext(this.injector, () => {
      // Effect to update scene based on rotation
      effect(() => {
        const rot = this.rotation();
        if (this.scene && this.directionalLight) {
          const radians = rot * Math.PI * 2;
          this.scene.backgroundRotation.y = radians;
          this.scene.environmentRotation.y = radians;

          // Rotate the light as well
          const rotatedDirection = this.initialLightDirection.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), radians);
          this.directionalLight.position.copy(rotatedDirection).multiplyScalar(50);
        }
      });

      // Effect to update scene based on exposure
      effect(() => {
        if (this.renderer) {
          this.renderer.toneMappingExposure = this.exposure();
        }
      });

      // Effect to update scene based on blur
      effect(() => {
        if (this.scene) {
          this.scene.backgroundBlurriness = this.blur();
        }
      });
      
      // Effect for tone mapping
      effect(() => {
        if (this.renderer) {
          switch(this.toneMapping()) {
            case 'ACES Filmic':
              this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
              break;
            case 'Reinhard':
              this.renderer.toneMapping = THREE.ReinhardToneMapping;
              break;
            case 'Cineon':
              this.renderer.toneMapping = THREE.CineonToneMapping;
              break;
            case 'None':
              this.renderer.toneMapping = THREE.NoToneMapping;
              break;
          }
        }
      });

      // Effect to toggle shadows and associated lights
      effect(() => {
        const enabled = this.shadowsVisible();
        if (this.renderer) {
          this.renderer.shadowMap.enabled = enabled;
        }
        if (this.directionalLight) {
          this.directionalLight.visible = enabled;
        }
        if (this.ambientLight) {
          this.ambientLight.visible = enabled;
        }
        
        // We need to update materials for the change to take effect
        if (this.scene) {
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

      // Effect to toggle object visibility
      effect(() => {
        const showSpheres = this.spheresVisible();
        for (const sphere of this.sphereObjects) {
          sphere.visible = showSpheres;
        }

        if (this.colorCheckerObject) {
          this.colorCheckerObject.visible = this.colorCheckerVisible();
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

    window.addEventListener('resize', this.onWindowResize.bind(this));
  }

  private createCheckerboardTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not get 2D context from canvas');
    }

    const size = 128;
    const halfSize = size / 2;

    context.fillStyle = '#555';
    context.fillRect(0, 0, size, size);
    context.fillStyle = '#999';
    context.fillRect(0, 0, halfSize, halfSize);
    context.fillRect(halfSize, halfSize, halfSize, halfSize);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(this.floorTiling(), this.floorTiling());
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private createCheckerboardBumpMap(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not get 2D context from canvas');
    }

    const size = 128;
    const halfSize = size / 2;

    // Black for lower areas
    context.fillStyle = '#000000';
    context.fillRect(0, 0, size, size);
    // White for higher areas, matching the color map pattern
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, halfSize, halfSize);
    context.fillRect(halfSize, halfSize, halfSize, halfSize);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(this.floorTiling(), this.floorTiling());
    return texture;
  }
  
  private createColorChecker(): THREE.Group {
    const colorCheckerGroup = new THREE.Group();
    const colors = [
      // Row 1
      [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
      // Row 2
      [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
      // Row 3
      [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
      // Row 4
      [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52]
    ];

    const rows = 4;
    const cols = 6;
    const patchSize = 0.5;
    const patchMargin = 0.05;
    const totalWidth = cols * patchSize + (cols - 1) * patchMargin;
    const totalHeight = rows * patchSize + (rows - 1) * patchMargin;

    const geometry = new THREE.BoxGeometry(patchSize, patchSize, 0.1);

    this.colorCheckerPatches = [];
    for (let i = 0; i < rows; i++) {
        this.colorCheckerPatches.push([]);
    }

    for (let i = 0; i < colors.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;

      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(colors[i][0] / 255, colors[i][1] / 255, colors[i][2] / 255),
        roughness: 0.8,
        metalness: 0.1,
      });

      const patch = new THREE.Mesh(geometry, material);
      patch.castShadow = true;
      patch.receiveShadow = true;

      const x = col * (patchSize + patchMargin) - totalWidth / 2 + patchSize / 2;
      const y = (rows - 1 - row) * (patchSize + patchMargin) - totalHeight / 2 + patchSize / 2;

      patch.position.set(x, y, 0);
      colorCheckerGroup.add(patch);
      this.colorCheckerPatches[row].push(patch);
    }
    
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
    this.scene.add(plasticSphere);
    this.sphereObjects.push(plasticSphere);

    // Color Checker
    this.colorCheckerObject = this.createColorChecker();
    this.scene.add(this.colorCheckerObject);

    // Lights
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.ambientLight);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    this.directionalLight.position.set(5, 10, 7.5);
    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.width = 2048;
    this.directionalLight.shadow.mapSize.height = 2048;
    this.directionalLight.shadow.camera.near = 0.5;
    this.directionalLight.shadow.camera.far = 100;
    this.directionalLight.shadow.camera.left = -15;
    this.directionalLight.shadow.camera.right = 15;
    this.directionalLight.shadow.camera.top = 15;
    this.directionalLight.shadow.camera.bottom = -15;
    this.directionalLight.shadow.radius = 4;
    this.directionalLight.shadow.blurSamples = 8;
    this.scene.add(this.directionalLight);
    this.scene.add(this.directionalLight.target);
  }

  private loadHdri(url: string, message: string): void {
    this.isLoading.set(true);
    this.loadingMessage.set(message);
    new HDRLoader().load(url, (texture: any) => {
        const envMap = this.pmremGenerator.fromEquirectangular(texture).texture;
        this.scene.background = envMap;
        this.scene.environment = envMap;

        this.updateLightsFromHdri(texture);

        texture.dispose();
        this.isLoading.set(false);
      }, undefined, (error: any) => {
          console.error('An error occurred while loading the HDRI.', error);
          this.loadingMessage.set('Error loading HDRI.');
      }
    );
  }

  private updateLightsFromHdri(texture: THREE.DataTexture): void {
    if (!texture.image || !this.directionalLight || !this.ambientLight) {
        return;
    }

    const { data, width, height } = texture.image;

    let maxLuminance = 0;
    let brightestPixelIndex = 0;

    for (let i = 0; i < data.length; i += 3) {
        const luminance = 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
        if (luminance > maxLuminance) {
            maxLuminance = luminance;
            brightestPixelIndex = i / 3;
        }
    }
    
    // --- Calculate shadow softness ---
    const highThreshold = maxLuminance * 0.95;
    let brightAreaSize = 0;
    for (let i = 0; i < data.length; i += 3) {
        const luminance = 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
        if (luminance >= highThreshold) {
            brightAreaSize++;
        }
    }
    const sunSizeRatio = brightAreaSize / (width * height);
    const shadowRadius = THREE.MathUtils.lerp(0.5, 10, Math.min(1, sunSizeRatio * 1000));
    this.directionalLight.shadow.radius = shadowRadius;
    this.directionalLight.shadow.blurSamples = Math.ceil(shadowRadius * 2);

    // --- Position light ---
    const brightestX = brightestPixelIndex % width;
    const brightestY = Math.floor(brightestPixelIndex / width);

    const u = brightestX / width;
    const v = brightestY / height;
    
    const theta = u * 2 * Math.PI;
    const phi = v * Math.PI;

    // Ensure the light is always above the horizon to cast a shadow
    const correctedPhi = Math.min(phi, (Math.PI / 2) - 0.1);

    const lightDirection = new THREE.Vector3();
    lightDirection.setFromSphericalCoords(1, correctedPhi, theta);
    
    // Store the base direction so we can rotate it later
    this.initialLightDirection.copy(lightDirection);

    // Apply the current rotation to the light
    const currentRotation = this.rotation() * Math.PI * 2;
    const rotatedDirection = this.initialLightDirection.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), currentRotation);
    
    this.directionalLight.position.copy(rotatedDirection).multiplyScalar(50);
    this.directionalLight.target.position.set(0, 0, 0);
    this.directionalLight.target.updateMatrixWorld();

    // --- Set intensity ---
    const intensity = Math.min(8, Math.max(0.5, maxLuminance / 10));
    this.directionalLight.intensity = intensity;
    this.ambientLight.intensity = Math.min(0.5, intensity * 0.1);
  }

  private animate(): void {
    requestAnimationFrame(this.animate.bind(this));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private onWindowResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  resetView(): void {
    if (this.camera && this.controls) {
      this.camera.position.set(0, 1.5, 8);
      this.controls.target.set(0, 1, 0);
      this.controls.update();
    }
  }

  renderScene(): void {
    this.renderer.render(this.scene, this.camera); // Ensure latest frame is drawn
    
    const dataUrl = this.renderer.domElement.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    
    const hdriName = this.selectedHdriName()?.replace(/\.(hdr|pic)$/i, '') || 'scene';
    link.download = `${hdriName}-render.png`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    
    if (!event.dataTransfer?.files) return;

    this.handleFiles(event.dataTransfer.files);
  }

  onHdriUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files) return;
    this.handleFiles(input.files);
    input.value = ''; // Reset input
  }

  private handleFiles(files: FileList): void {
    const newHdris: HDRI[] = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file && (file.name.endsWith('.hdr') || file.name.endsWith('.pic'))) {
            const url = URL.createObjectURL(file);
            newHdris.push({ name: file.name, url, file });
        }
    }
    
    if (newHdris.length > 0) {
      this.hdriList.update(currentList => {
        const newNames = new Set(newHdris.map(h => h.name));
        const filteredList = currentList.filter(h => !newNames.has(h.name));
        return [...filteredList, ...newHdris];
      });
      this.selectedHdriName.set(newHdris[0].name);
    }
  }

  toggleAllObjects(): void {
    const shouldShow = !this.anyObjectVisible();
    this.spheresVisible.set(shouldShow);
    this.colorCheckerVisible.set(shouldShow);
    this.groundVisible.set(shouldShow);
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
    switch(preset) {
        case 'SHV':
            this.applyShvPreset();
            break;
        case 'Polyhaven':
            this.applyPolyhavenPreset();
            break;
        case 'Grayscale':
            this.applyGrayscalePreset();
            break;
        case 'SkinTone':
            this.applySkinTonePreset();
            break;
    }
  }

  private resetMaterialsToDefault(): void {
    // Glass
    this.glassColor.set('#ffffff');
    this.glassRoughness.set(0);
    this.glassIor.set(1.5);
    this.glassTransmission.set(1);
    // Matte
    this.matteColor.set('#ffffff');
    this.matteRoughness.set(1);
    this.matteMetalness.set(0);
    // Chrome
    this.chromeColor.set('#ffffff');
    this.chromeRoughness.set(0);
    this.chromeMetalness.set(1);
    // Plastic
    this.plasticColor.set('#00bcd4');
    this.plasticRoughness.set(0.1);
    this.plasticMetalness.set(0.05);
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
    this.plasticColor.set('#353535'); // Dark charcoal gray for "black"
    this.spheresVisible.set(true);
    this.colorCheckerVisible.set(true);
    this.groundVisible.set(true);
    this.setColorCheckerRowsVisibility(true, [0, 1, 2, 3]);
  }

  private applyPolyhavenPreset(): void {
    this.resetMaterialsToDefault();
    this.spheresVisible.set(true);
    this.colorCheckerVisible.set(false);
    this.groundVisible.set(true);
  }

  private applyGrayscalePreset(): void {
    this.spheresVisible.set(true);
    this.colorCheckerVisible.set(true);
    this.groundVisible.set(false);
    this.setColorCheckerRowsVisibility(true, [3]); // Grayscale row is the last one (index 3)

    const roughness = 0.30;
    const metalness = 0.05;
    // sRGB approximations for 9%, 18%, 36%, 72% linear gray
    const colors = ['#525252', '#757575', '#A3A3A3', '#DBDBDB'];

    // Glass sphere -> Opaque Gray
    this.glassTransmission.set(0);
    this.glassColor.set(colors[0]);
    this.glassRoughness.set(roughness);
    this.glassIor.set(1.5);

    // Matte sphere
    this.matteColor.set(colors[1]);
    this.matteRoughness.set(roughness);
    this.matteMetalness.set(metalness);

    // Chrome sphere
    this.chromeColor.set(colors[2]);
    this.chromeRoughness.set(roughness);
    this.chromeMetalness.set(metalness);

    // Plastic sphere
    this.plasticColor.set(colors[3]);
    this.plasticRoughness.set(roughness);
    this.plasticMetalness.set(metalness);
  }

  private applySkinTonePreset(): void {
    this.spheresVisible.set(true);
    this.colorCheckerVisible.set(false);
    this.groundVisible.set(true);

    const roughness = 0.5;
    const metalness = 0;
    const colors = ['#F2D5B8', '#E0A98E', '#9E6E55', '#6E4A36'];

    // Glass sphere -> Skin tone
    this.glassTransmission.set(0);
    this.glassColor.set(colors[0]);
    this.glassRoughness.set(roughness);
    this.glassIor.set(1.4); // Skin IOR

    // Matte sphere
    this.matteColor.set(colors[1]);
    this.matteRoughness.set(roughness);
    this.matteMetalness.set(metalness);

    // Chrome sphere
    this.chromeColor.set(colors[2]);
    this.chromeRoughness.set(roughness);
    this.chromeMetalness.set(metalness);

    // Plastic sphere
    this.plasticColor.set(colors[3]);
    this.plasticRoughness.set(roughness);
    this.plasticMetalness.set(metalness);
  }

  toggleTheme(): void {
    this.theme.update(current => current === 'dark' ? 'light' : 'dark');
  }

  async saveProject(): Promise<void> {
    this.isLoading.set(true);
    this.loadingMessage.set('Saving project...');
    try {
        const hdriDataPromises = this.hdriList().map(async (hdri) => {
            if (hdri.file) {
                return { name: hdri.name, data: await this.fileToBase64(hdri.file) };
            }

            if (typeof hdri.url === 'string' && (hdri.url.startsWith('http') || hdri.url.startsWith('blob:'))) {
                try {
                    const response = await fetch(hdri.url);
                    if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
                    const blob = await response.blob();
                    const tempFile = new File([blob], hdri.name, { type: 'image/vnd.radiance' });
                    return { name: hdri.name, data: await this.fileToBase64(tempFile) };
                } catch (error) {
                    console.error(`Failed to process HDRI from URL '${hdri.url}'`, error);
                    return null;
                }
            }
            
            console.warn('Skipping invalid HDRI entry during save:', hdri);
            return null;
        });
        
        const resolvedHdriData = (await Promise.all(hdriDataPromises)).filter((d): d is { name: string; data: string; } => d !== null);

        const [
            floorTexture, 
            glassRoughnessTexture,
            matteRoughnessTexture,
            chromeRoughnessTexture,
            plasticRoughnessTexture
        ] = await Promise.all([
            this.floorTextureFile() ? this.fileToTextureData(this.floorTextureFile()!) : Promise.resolve(null),
            this.glassRoughnessTextureFile() ? this.fileToTextureData(this.glassRoughnessTextureFile()!) : Promise.resolve(null),
            this.matteRoughnessTextureFile() ? this.fileToTextureData(this.matteRoughnessTextureFile()!) : Promise.resolve(null),
            this.chromeRoughnessTextureFile() ? this.fileToTextureData(this.chromeRoughnessTextureFile()!) : Promise.resolve(null),
            this.plasticRoughnessTextureFile() ? this.fileToTextureData(this.plasticRoughnessTextureFile()!) : Promise.resolve(null)
        ]);
        
        const project: ProjectDataV1_2 = {
            version: '1.2',
            settings: {
                rotation: this.rotation(),
                exposure: this.exposure(),
                blur: this.blur(),
                selectedHdriName: this.selectedHdriName(),
                toneMapping: this.toneMapping(),
                spheresVisible: this.spheresVisible(),
                groundVisible: this.groundVisible(),
                shadowsVisible: this.shadowsVisible(),
                colorCheckerVisible: this.colorCheckerVisible(),
            },
            materials: {
                floor: {
                    tiling: this.floorTiling(),
                    texture: floorTexture,
                },
                glass: {
                    roughness: this.glassRoughness(),
                    ior: this.glassIor(),
                    roughnessTexture: glassRoughnessTexture,
                },
                matte: {
                    color: this.matteColor(),
                    roughness: this.matteRoughness(),
                    metalness: this.matteMetalness(),
                    roughnessTexture: matteRoughnessTexture,
                },
                chrome: {
                    color: this.chromeColor(),
                    roughness: this.chromeRoughness(),
                    metalness: this.chromeMetalness(),
                    roughnessTexture: chromeRoughnessTexture,
                },
                plastic: {
                    color: this.plasticColor(),
                    roughness: this.plasticRoughness(),
                    metalness: this.plasticMetalness(),
                    roughnessTexture: plasticRoughnessTexture,
                }
            },
            hdris: resolvedHdriData,
        };

        const jsonString = JSON.stringify(project);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'hdri-project.hdriv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      
    } catch(error) {
        console.error("Failed to save project", error);
        this.loadingMessage.set("Error: Could not save project.");
        setTimeout(() => this.isLoading.set(false), 2000);
        return;
    }
    this.isLoading.set(false);
  }

  onProjectLoad(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    
    const file = input.files[0];
    const reader = new FileReader();

    reader.onload = (e) => {
        try {
            const result = e.target?.result as string;
            const project: AnyProjectData = JSON.parse(result);
            if (!project.version || !project.hdris || !project.settings) {
                throw new Error('Invalid project file format.');
            }
            
            this.isLoading.set(true);
            this.loadingMessage.set('Loading project...');

            this.hdriList().forEach(hdri => {
                if (hdri.url && hdri.url.startsWith('blob:')) {
                    URL.revokeObjectURL(hdri.url);
                }
            });

            const loadedHdris: HDRI[] = project.hdris.map(hdriData => {
                const blob = this.base64ToBlob(hdriData.data);
                const file = new File([blob], hdriData.name, {type: blob.type});
                return { name: hdriData.name, url: URL.createObjectURL(blob), file: file };
            });

            this.hdriList.set(loadedHdris);
            this.currentPreset.set('SHV'); // Reset to a known state after loading
            
            // --- Load Settings ---
            const settings = project.settings;
            this.rotation.set(settings.rotation);
            this.exposure.set(settings.exposure);
            this.blur.set(settings.blur);
            
            if (settings.toneMapping) {
                // FIX: Cast toneMapping to 'any' to allow comparison with legacy values from older project files that are not in the 'ToneMappingOption' type.
                if ((settings.toneMapping as any) === 'Linear' || (settings.toneMapping as any) === 'None (sRGB)') {
                    this.toneMapping.set('None');
                } else if (['ACES Filmic', 'Reinhard', 'Cineon', 'None'].includes(settings.toneMapping)) {
                    this.toneMapping.set(settings.toneMapping);
                } else {
                    this.toneMapping.set('ACES Filmic');
                }
            } else {
                this.toneMapping.set('ACES Filmic');
            }
            
            // --- Load Version 1.1+ Data ---
            if (project.version === '1.1' || project.version === '1.2') {
                this.spheresVisible.set(project.settings.spheresVisible);
                this.groundVisible.set(project.settings.groundVisible);
                this.shadowsVisible.set(project.settings.shadowsVisible);
                this.colorCheckerVisible.set(project.settings.colorCheckerVisible);

                const materials = project.materials;
                this.floorTiling.set(materials.floor.tiling);
                if (materials.floor.texture) {
                    const blob = this.base64ToBlob(materials.floor.texture.data);
                    const file = new File([blob], materials.floor.texture.name, { type: blob.type });
                    this.loadAndApplyFloorTexture(file);
                } else {
                    this.restoreDefaultFloorTexture();
                }

                this.glassRoughness.set(materials.glass.roughness);
                this.glassIor.set(materials.glass.ior);

                this.matteColor.set(materials.matte.color);
                this.matteRoughness.set(materials.matte.roughness);
                this.matteMetalness.set(materials.matte.metalness);

                this.chromeColor.set(materials.chrome.color);
                this.chromeRoughness.set(materials.chrome.roughness);
                this.chromeMetalness.set(materials.chrome.metalness);
                if (materials.chrome.roughnessTexture) {
                    const blob = this.base64ToBlob(materials.chrome.roughnessTexture.data);
                    const file = new File([blob], materials.chrome.roughnessTexture.name, { type: blob.type });
                    this.loadAndApplyRoughnessTexture(file, 2, this.chromeRoughnessTextureFile);
                } else {
                    this.removeRoughnessTexture(2, this.chromeRoughnessTextureFile);
                }

                this.plasticColor.set(materials.plastic.color);
                this.plasticRoughness.set(materials.plastic.roughness);
                this.plasticMetalness.set(materials.plastic.metalness);
            }

            // --- Load Version 1.2+ Data ---
            if (project.version === '1.2') {
                const materials = project.materials;
                if (materials.glass.roughnessTexture) {
                    const blob = this.base64ToBlob(materials.glass.roughnessTexture.data);
                    const file = new File([blob], materials.glass.roughnessTexture.name, { type: blob.type });
                    this.loadAndApplyRoughnessTexture(file, 0, this.glassRoughnessTextureFile);
                } else {
                    this.removeRoughnessTexture(0, this.glassRoughnessTextureFile);
                }
                if (materials.matte.roughnessTexture) {
                    const blob = this.base64ToBlob(materials.matte.roughnessTexture.data);
                    const file = new File([blob], materials.matte.roughnessTexture.name, { type: blob.type });
                    this.loadAndApplyRoughnessTexture(file, 1, this.matteRoughnessTextureFile);
                } else {
                    this.removeRoughnessTexture(1, this.matteRoughnessTextureFile);
                }
                if (materials.plastic.roughnessTexture) {
                    const blob = this.base64ToBlob(materials.plastic.roughnessTexture.data);
                    const file = new File([blob], materials.plastic.roughnessTexture.name, { type: blob.type });
                    this.loadAndApplyRoughnessTexture(file, 3, this.plasticRoughnessTextureFile);
                } else {
                    this.removeRoughnessTexture(3, this.plasticRoughnessTextureFile);
                }

            } else { // Fallback for pre-1.2 versions
                this.removeRoughnessTexture(0, this.glassRoughnessTextureFile);
                this.removeRoughnessTexture(1, this.matteRoughnessTextureFile);
                this.removeRoughnessTexture(3, this.plasticRoughnessTextureFile);
            }
            
            
            if (project.version === '1.0') { // --- Fallback for Version 1.0 ---
                this.spheresVisible.set(true);
                this.groundVisible.set(true);
                this.shadowsVisible.set(true);
                this.colorCheckerVisible.set(true);
                
                this.floorTiling.set(40);
                this.restoreDefaultFloorTexture();
                this.glassRoughness.set(0);
                this.glassIor.set(1.5);
                this.matteColor.set('#ffffff');
                this.matteRoughness.set(1);
                this.matteMetalness.set(0);
                this.chromeColor.set('#ffffff');
                this.chromeRoughness.set(0);
                this.chromeMetalness.set(1);
                this.removeRoughnessTexture(2, this.chromeRoughnessTextureFile);
                this.plasticColor.set('#00bcd4');
                this.plasticRoughness.set(0.1);
                this.plasticMetalness.set(0.05);
            }
            
            // This needs to be set last to trigger the HDRI loading effect
            this.selectedHdriName.set(project.settings.selectedHdriName);

        } catch (error) {
            console.error('Failed to load project:', error);
            alert('Failed to load project. The file may be corrupt or in the wrong format.');
            this.isLoading.set(false);
        }
    };
    
    reader.onerror = () => {
        alert('Error reading project file.');
        this.isLoading.set(false);
    }

    reader.readAsText(file);
    input.value = ''; // Reset input
  }

  async loadDemoScene(): Promise<void> {
    this.isLoading.set(true);
    this.loadingMessage.set('Loading Demo Scene...');

    try {
      const demoHdriUrl = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr';
      const response = await fetch(demoHdriUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch demo HDRI: ${response.statusText}`);
      }
      const blob = await response.blob();
      const file = new File([blob], "studio_small_09_1k.hdr", { type: 'image/vnd.radiance' });
      
      const url = URL.createObjectURL(file);
      const demoHdri: HDRI = { name: 'Studio Small 09 Demo', url, file };

      // Make sure any previous object URLs are revoked
      this.hdriList().forEach(hdri => {
        if (hdri.url && hdri.url.startsWith('blob:')) {
            URL.revokeObjectURL(hdri.url)
        }
      });

      // Reset scene to a good starting point
      this.hdriList.set([demoHdri]);
      this.currentPreset.set('SHV'); // This will reset materials etc.
      this.applyShvPreset(); // Explicitly call to ensure it's applied
      this.rotation.set(0);
      this.exposure.set(1);
      this.blur.set(0);
      this.toneMapping.set('ACES Filmic');
      this.spheresVisible.set(true);
      this.groundVisible.set(true);
      this.shadowsVisible.set(true);
      this.colorCheckerVisible.set(true);
      
      // This needs to be set last to trigger the loading effect
      this.selectedHdriName.set(demoHdri.name);

    } catch (error) {
      console.error('Failed to load demo scene:', error);
      this.loadingMessage.set('Error: Could not load demo scene.');
      // Keep the loading screen for a bit to show the error, then hide it.
      setTimeout(() => this.isLoading.set(false), 3000);
    }
  }

  onFloorTextureUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    this.loadAndApplyFloorTexture(file);
    input.value = '';
  }

  resetFloorTexture(): void {
    this.restoreDefaultFloorTexture();
  }

  onGlassRoughnessUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadAndApplyRoughnessTexture(input.files[0], 0, this.glassRoughnessTextureFile);
    input.value = '';
  }

  resetGlassRoughnessTexture(): void {
    this.removeRoughnessTexture(0, this.glassRoughnessTextureFile);
  }

  onMatteRoughnessUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadAndApplyRoughnessTexture(input.files[0], 1, this.matteRoughnessTextureFile);
    input.value = '';
  }

  resetMatteRoughnessTexture(): void {
    this.removeRoughnessTexture(1, this.matteRoughnessTextureFile);
  }

  onChromeRoughnessUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadAndApplyRoughnessTexture(input.files[0], 2, this.chromeRoughnessTextureFile);
    input.value = '';
  }

  resetChromeRoughnessTexture(): void {
    this.removeRoughnessTexture(2, this.chromeRoughnessTextureFile);
  }

  onPlasticRoughnessUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    this.loadAndApplyRoughnessTexture(input.files[0], 3, this.plasticRoughnessTextureFile);
    input.value = '';
  }

  resetPlasticRoughnessTexture(): void {
    this.removeRoughnessTexture(3, this.plasticRoughnessTextureFile);
  }

  private loadAndApplyFloorTexture(file: File): void {
    this.floorTextureFile.set(file);
    const url = URL.createObjectURL(file);
    this.textureLoader.load(url, (texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        
        const material = this.groundObject.material as THREE.MeshStandardMaterial;
        if (material.map) material.map.dispose();
        if (material.bumpMap) material.bumpMap.dispose();

        material.map = texture;
        material.bumpMap = null; // Remove checker bump when using custom texture
        material.needsUpdate = true;
        
        texture.repeat.set(this.floorTiling(), this.floorTiling());

        URL.revokeObjectURL(url);
    });
  }

  private restoreDefaultFloorTexture(): void {
    this.floorTextureFile.set(null);
    const material = this.groundObject.material as THREE.MeshStandardMaterial;
    if (material.map) material.map.dispose();
    if (material.bumpMap) material.bumpMap.dispose();
    
    material.map = this.createCheckerboardTexture();
    material.bumpMap = this.createCheckerboardBumpMap();
    material.needsUpdate = true;
  }
  
  private loadAndApplyRoughnessTexture(file: File, sphereIndex: number, fileSignal: WritableSignal<File | null>): void {
    fileSignal.set(file);
    const url = URL.createObjectURL(file);
    const sphere = this.sphereObjects[sphereIndex];
    if (sphere) {
        this.textureLoader.load(url, (texture) => {
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            texture.colorSpace = THREE.NoColorSpace; 
            
            const material = sphere.material as THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
            if (material.roughnessMap) material.roughnessMap.dispose();
            
            material.roughnessMap = texture;
            material.needsUpdate = true;

            URL.revokeObjectURL(url);
        });
    }
  }

  private removeRoughnessTexture(sphereIndex: number, fileSignal: WritableSignal<File | null>): void {
    fileSignal.set(null);
    const sphere = this.sphereObjects[sphereIndex];
    if (sphere) {
        const material = sphere.material as THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
        if (material.roughnessMap) {
            material.roughnessMap.dispose();
            material.roughnessMap = null;
            material.needsUpdate = true;
        }
    }
  }

  private fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = error => reject(error);
    });
  };

  private fileToTextureData = async (file: File): Promise<TextureData> => {
    return {
      name: file.name,
      data: await this.fileToBase64(file)
    };
  };

  private base64ToBlob = (base64: string): Blob => {
    const parts = base64.split(';base64,');
    const contentType = parts[0].split(':')[1];
    const raw = window.atob(parts[1]);
    const rawLength = raw.length;
    const uInt8Array = new Uint8Array(rawLength);

    for (let i = 0; i < rawLength; ++i) {
      uInt8Array[i] = raw.charCodeAt(i);
    }
    return new Blob([uInt8Array], { type: contentType });
  };
}
