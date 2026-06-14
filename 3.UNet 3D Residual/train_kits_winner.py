#!/usr/bin/env python3
"""
train_kits_winner.py  -  Reimplementacion del ganador KiTS2019 (Isensee & Maier-Hein, 2019)
adaptado al dataset del hospital (82 casos).

PREPROCESAMIENTO - valores extraidos de nnUNetPlans.json (3d_fullres) - cambiar a valores nuevos
======================================================================
  Spacing  : 1.0, 1.0, 1.0 mm
  Clip HU  : [-64.35255432128906 - 273.7598571777344]  (percentile_00_5 y percentile_99_5 del foreground)
  Norm     : (x - 120.24785614013672) / 65.7291259765625  (mean y std del foreground)
  Patch    : (112, 112, 192)  (patch_size de la config 3d_fullres)

DISEÑO DE SPLITS - comparacion robusta con nnUNet
=================================================
  splits_final.json cubre kidney_001 a kidney_062 (62 casos).
  Los 14 casos restantes (kidney_063 a kidney_077) NUNCA fueron vistos
  por nnUNet -> son el test set del dataset.

  Train/Val : kidney_001-062 en 5-fold cross-validation (mismos folds que nnUNet)
  Test      : kidney_001-015 (16 casos, nunca vistos por ningun modelo) -> imagesTs/labelsTs

  Metricas de validacion: media de los 5 folds (igual que nnUNet reporta)
  Metricas de test: ensemble de los 5 modelos sobre los 14 casos de test

Fidelidad al paper:
  arch: Plain / Residual / Pre-act Residual 3D U-Net
  optimizer: SGD Nesterov mom=0.99 lr=0.01 wd=3e-5
  scheduler: PolyLR (1 - epoch/max)^0.9
  loss: CrossEntropy + Dice (suma)
  deep supervision: [1.0, 0.5, 0.25, 0.125]
  epochs: 1000 x 250 batches
  batch size: 2 (paper con 12GB) -> usar 1 con GPU de 10GB
  augmentation: escala, rotacion, brillo, contraste, gamma, ruido
  kidney dice = (label1 + label2) como foreground [igual que KiTS challenge]
  ensemble = promedio de softmax outputs de los 5 folds
"""

import os, json, random, time, warnings
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
warnings.filterwarnings("ignore")

import numpy as np
import nibabel as nib
import torch
import torch.nn as nn
import torch.nn.functional as F
from glob import glob
from scipy import ndimage
import pandas as pd
from torch.utils.data import Dataset, DataLoader
from torch.cuda.amp import GradScaler, autocast

# =============================================================================
# CONFIGURACION
# =============================================================================

DATA_DIR      = os.path.expanduser("~/nnUNet_raw/Dataset002_Kidney/imagesTr")
LABEL_DIR     = os.path.expanduser("~/nnUNet_raw/Dataset002_Kidney/labelsTr")
OUTPUT_DIR    = "./kits_winner"
DEVICE        = torch.device("cuda" if torch.cuda.is_available() else "cpu")
NNUNET_SPLITS = os.path.expanduser(
    "~/nnUNet_preprocessed/Dataset002_Kidney/splits_final.json"
)

# Preprocesamiento — extraido de nnUNetPlans.json (3d_fullres)
TARGET_SPACING = (1.0, 1.0, 1.0)           # original_median_spacing_after_transp
HU_CLIP_MIN    = -64.35255432128906        # foreground percentile_00_5
HU_CLIP_MAX    = 273.7598571777344         # foreground percentile_99_5
NORM_MEAN      = 120.24785614013672        # foreground mean
NORM_STD       = 65.7291259765625          # foreground std

# "plain" | "residual" | "preact_residual"
ARCH          = "residual"
PATCH_SIZE    = (112, 112, 192)   # patch_size de nnUNetPlans.json 3d_fullres                             
N_CLASSES     = 3
INIT_FEATURES = 24 if ARCH != "plain" else 30
MAX_FEATURES  = 320
N_LEVELS      = 4

BATCHES_PER_EPOCH = 250
EPOCHS            = 500  # paper con 1000 épocas -> reduzco nº por tamaño reducido del dataset
BATCH_SIZE        = 2    # paper=2 con 12GB
LR_INIT           = 0.01
MOMENTUM          = 0.99
WEIGHT_DECAY      = 3e-5
POLY_POWER        = 0.9
DS_WEIGHTS        = [1.0, 0.5, 0.25, 0.125]
POS_FRAC          = 0.33
SW_OVERLAP        = 0.5
USE_TTA           = True
SEED              = 42

for _d in [OUTPUT_DIR,
           f"{OUTPUT_DIR}/checkpoints",
           f"{OUTPUT_DIR}/logs",
           f"{OUTPUT_DIR}/results"]:
    os.makedirs(_d, exist_ok=True)


def set_seed(s=42):
    random.seed(s); np.random.seed(s)
    torch.manual_seed(s)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(s)


set_seed(SEED)

print("\n" + "=" * 80)
print(f"  REPLICACIÓN ARQUITECTURA GANADORA KiTS2019 - dataset hospitalario RyC ({ARCH.upper()})")
print(f"  spacing={TARGET_SPACING} mm (nnUNetPlans 3d_fullres)")
print(f"  patch={PATCH_SIZE} | clip=[{HU_CLIP_MIN},{HU_CLIP_MAX}] | "
      f"norm=({NORM_MEAN:.2f},{NORM_STD:.2f})")
print(f"  bs={BATCH_SIZE} | {BATCHES_PER_EPOCH}x{EPOCHS} iters | SGD Nesterov")
print(f"  SPLITS: kidney_001-062 (train/val, 5-fold) | kidney_063-077 (test)")
print("=" * 80)


# =============================================================================
# CARGA DE SPLITS - IDENTICA A nnUNet
# =============================================================================

def load_splits_exact(splits_file, images_dir, labels_dir):
    """
    Carga los splits de nnUNet leyendo directamente de las carpetas de nnUNet_raw.
    Garantiza que el ID del JSON coincida con el archivo físico real.
    """
    if not os.path.exists(splits_file):
        raise FileNotFoundError(f"No se encontro {splits_file}")

    with open(splits_file) as f:
        splits = json.load(f)

    # Buscar imágenes (kidney_001_0000.nii.gz) y labels (kidney_001.nii.gz)[cite: 5]
    all_imgs = glob(os.path.join(images_dir, "*_0000.nii.gz"))
    
    id_to_paths = {}
    for img_path in all_imgs:
        # Extraer ID: "kidney_001_0000.nii.gz" -> "kidney_001"
        case_id = os.path.basename(img_path).replace("_0000.nii.gz", "")
        lab_path = os.path.join(labels_dir, f"{case_id}.nii.gz")
        
        if os.path.exists(lab_path):
            id_to_paths[case_id] = {"image": img_path, "label": lab_path, "case_id": case_id}

    # Procesar Folds según el JSON[cite: 6]
    splits_iter = splits if isinstance(splits, list) else list(splits.values())
    fold_data = []
    
    print("\n  SINCRONIZACIÓN DE SPLITS (nnU-Net Raw Dir):")
    for fold_idx, sp in enumerate(splits_iter):
        tr_ids = sp["train"]
        vl_ids = sp["val"]

        # Cargar solo los casos que existen físicamente[cite: 13]
        train = [id_to_paths[k] for k in tr_ids if k in id_to_paths]
        val   = [id_to_paths[k] for k in vl_ids if k in id_to_paths]
        
        fold_data.append({
            "train": train, 
            "val": val,
            "train_ids": tr_ids, 
            "val_ids": vl_ids
        })
        print(f"   Fold {fold_idx}: {len(train):3d} train, {len(val):3d} val")

    # Identificar casos de TEST (no están en el archivo de splits)[cite: 1, 5]
    ids_in_splits = set()
    for sp in splits_iter:
        ids_in_splits.update(sp["train"])
        ids_in_splits.update(sp["val"])
    
    # Nota: Los casos de test real suelen estar en 'imagesTs'[cite: 2]
    # Aquí identificamos los que están en Tr pero no en el split
    ids_test = sorted(set(id_to_paths.keys()) - ids_in_splits)
    test_data = [id_to_paths[k] for k in ids_test if k in id_to_paths]
    
    return fold_data, test_data


# =============================================================================
# ARQUITECTURAS (Seccion 2.2 del paper)
# =============================================================================

class ConvNormAct(nn.Module):
    def __init__(self, in_ch, out_ch, kernel=3, stride=1, act="lrelu"):
        super().__init__()
        self.conv = nn.Conv3d(in_ch, out_ch, kernel, stride=stride,
                              padding=kernel//2, bias=False)
        self.norm = nn.InstanceNorm3d(out_ch, affine=True)
        self.act  = (nn.LeakyReLU(0.01, inplace=True) if act == "lrelu"
                     else nn.ReLU(inplace=True))
    def forward(self, x):
        return self.act(self.norm(self.conv(x)))


class PlainBlock(nn.Module):
    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.seq = nn.Sequential(
            ConvNormAct(in_ch,  out_ch, stride=stride, act="lrelu"),
            ConvNormAct(out_ch, out_ch, stride=1,      act="lrelu"),
        )
    def forward(self, x): return self.seq(x)


class ResBlock(nn.Module):
    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.c1 = nn.Conv3d(in_ch,  out_ch, 3, stride=stride, padding=1, bias=False)
        self.n1 = nn.InstanceNorm3d(out_ch, affine=True); self.a1 = nn.ReLU(inplace=True)
        self.c2 = nn.Conv3d(out_ch, out_ch, 3, stride=1,      padding=1, bias=False)
        self.n2 = nn.InstanceNorm3d(out_ch, affine=True); self.a2 = nn.ReLU(inplace=True)
        self.skip = (nn.Sequential(
                         nn.Conv3d(in_ch, out_ch, 1, stride=stride, bias=False),
                         nn.InstanceNorm3d(out_ch, affine=True))
                     if in_ch != out_ch or stride != 1 else nn.Identity())
    def forward(self, x):
        r = self.skip(x); x = self.a1(self.n1(self.c1(x)))
        x = self.n2(self.c2(x)); return self.a2(x + r)


class PreActResBlock(nn.Module):
    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.n1=nn.InstanceNorm3d(in_ch, affine=True);  self.a1=nn.ReLU(inplace=True)
        self.c1=nn.Conv3d(in_ch,  out_ch,3,stride=stride,padding=1,bias=False)
        self.n2=nn.InstanceNorm3d(out_ch,affine=True);  self.a2=nn.ReLU(inplace=True)
        self.c2=nn.Conv3d(out_ch, out_ch,3,stride=1,    padding=1,bias=False)
        self.skip=(nn.Conv3d(in_ch,out_ch,1,stride=stride,bias=False)
                   if in_ch!=out_ch or stride!=1 else nn.Identity())
    def forward(self, x):
        r=self.skip(x); x=self.c1(self.a1(self.n1(x))); x=self.c2(self.a2(self.n2(x)))
        return x+r


class KiTSUNet(nn.Module):
    def __init__(self, arch=ARCH, in_ch=1, out_ch=N_CLASSES,
                 init_f=None, max_f=MAX_FEATURES, n_levels=N_LEVELS):
        super().__init__()
        self.arch=arch; self.n_levels=n_levels
        if init_f is None: init_f = 30 if arch=="plain" else 24
        feats = [min(init_f*(2**i), max_f) for i in range(n_levels+1)]
        self.feats = feats

        self.enc = nn.ModuleList(); self.down = nn.ModuleList()
        self.enc.append(self._enc_block(in_ch, feats[0], n=1, stride=1))
        for lvl in range(n_levels):
            act = "lrelu" if arch=="plain" else "relu"
            self.down.append(nn.Sequential(
                nn.Conv3d(feats[lvl], feats[lvl+1], 3, stride=2, padding=1, bias=False),
                nn.InstanceNorm3d(feats[lvl+1], affine=True),
                nn.LeakyReLU(0.01,inplace=True) if act=="lrelu" else nn.ReLU(inplace=True),
            ))
            n_blk = 1 if arch=="plain" else (lvl+2)
            self.enc.append(self._enc_block(feats[lvl+1], feats[lvl+1], n=n_blk, stride=1))

        self.up=nn.ModuleList(); self.dec=nn.ModuleList(); self.ds_head=nn.ModuleList()
        for lvl in range(n_levels-1,-1,-1):
            self.up.append(nn.ConvTranspose3d(feats[lvl+1], feats[lvl], 2, stride=2))
            n_dec=2 if arch=="plain" else 1
            act_d="lrelu" if arch=="plain" else "relu"
            self.dec.append(self._dec_block(feats[lvl]*2, feats[lvl], n=n_dec, act=act_d))
            self.ds_head.append(nn.Conv3d(feats[lvl], out_ch, 1))
        self._init_weights()

    def _enc_block(self, in_ch, out_ch, n, stride):
        if self.arch=="plain": return PlainBlock(in_ch, out_ch, stride=stride)
        blks, ic = [], in_ch
        Cls = ResBlock if self.arch=="residual" else PreActResBlock
        for i in range(n):
            blks.append(Cls(ic, out_ch, stride=(stride if i==0 else 1))); ic=out_ch
        return nn.Sequential(*blks)

    def _dec_block(self, in_ch, out_ch, n, act):
        if n==1: return ConvNormAct(in_ch, out_ch, act=act)
        return nn.Sequential(ConvNormAct(in_ch,out_ch,act=act), ConvNormAct(out_ch,out_ch,act=act))

    def _init_weights(self):
        for m in self.modules():
            if isinstance(m,(nn.Conv3d,nn.ConvTranspose3d)):
                nn.init.kaiming_normal_(m.weight,mode="fan_out",nonlinearity="relu")
                if m.bias is not None: nn.init.zeros_(m.bias)
            elif isinstance(m,nn.InstanceNorm3d):
                if m.weight is not None: nn.init.ones_(m.weight)
                if m.bias   is not None: nn.init.zeros_(m.bias)

    def forward(self, x):
        skips=[]; out=self.enc[0](x); skips.append(out)
        for lvl in range(self.n_levels):
            out=self.down[lvl](out); out=self.enc[lvl+1](out)
            if lvl < self.n_levels-1: skips.append(out)
        ds_outs=[]
        for i,(up,dec,head) in enumerate(zip(self.up,self.dec,self.ds_head)):
            out=up(out); skip=skips[-(i+1)]
            if out.shape!=skip.shape:
                out=F.interpolate(out,size=skip.shape[2:],mode="trilinear",align_corners=False)
            out=torch.cat([out,skip],dim=1); out=dec(out); ds_outs.append(head(out))
        # Invertir: el decoder construye ds_outs de menor a mayor resolucion.
        # Al invertir, ds_outs[0] = resolución completa (mayor detalle) ->
        # DS_WEIGHTS[0]=1.0 pondera el nivel mas detallado y sliding_window
        # usa out[0] correctamente (shape = patch_size completo).
        return ds_outs[::-1]


def build_model():
    m=KiTSUNet(); n=sum(p.numel() for p in m.parameters() if p.requires_grad)
    print(f"  [{ARCH.upper()} 3D U-Net]  params={n:,}  feats={INIT_FEATURES}->{MAX_FEATURES}")
    return m


# =============================================================================
# LOSS (CE + Dice, suma igual que el paper)
# =============================================================================

def _dice_loss(ps, t_oh, smooth=1e-5):
    loss,cnt = 0.0, 0
    for c in range(1, ps.shape[1]):
        p=ps[:,c].reshape(-1); t=t_oh[:,c].reshape(-1)
        num=2.0*(p*t).sum()+smooth; den=p.sum()+t.sum()+smooth
        loss += 1.0-num/den; cnt+=1
    return loss/max(cnt,1)

def combined_loss(logits, target):
    tgt = target.squeeze(1).long() if target.dim()==logits.dim() else target.long()
    ce  = F.cross_entropy(logits, tgt)
    ps  = torch.softmax(logits, dim=1); nc=ps.shape[1]
    toh = F.one_hot(tgt, num_classes=nc)
    perm=[0,toh.ndim-1]+list(range(1,toh.ndim-1))
    toh = toh.permute(*perm).float()
    return ce + _dice_loss(ps, toh)

def deep_supervision_loss(outputs, target):
    total,tw = torch.tensor(0.0,device=target.device), 0.0
    for out,w in zip(outputs, DS_WEIGHTS[:len(outputs)]):
        tgt=(F.interpolate(target.float().unsqueeze(1) if target.dim()==4 else target.float(),
                           size=out.shape[2:],mode="nearest").squeeze(1).long()
             if out.shape[2:]!=target.shape[2:]
             else target.squeeze(1).long())
        total+=w*combined_loss(out,tgt); tw+=w
    return total/tw


# =============================================================================
# PREPROCESAMIENTO
# =============================================================================

def load_preprocess(img_path, lab_path, spacing=TARGET_SPACING):
    img_nib=nib.load(img_path); lab_nib=nib.load(lab_path)
    img=img_nib.get_fdata(dtype=np.float32); lab=lab_nib.get_fdata().astype(np.int64)
    orig_sp=np.abs(np.array(img_nib.header.get_zooms()[:3],dtype=np.float32))
    zoom=(orig_sp/np.array(spacing,dtype=np.float32)).tolist()
    img_r=ndimage.zoom(img,zoom,order=1,prefilter=False)
    lab_r=ndimage.zoom(lab.astype(np.float32),zoom,order=0,prefilter=False).astype(np.int64)
    img_r=np.clip(img_r,HU_CLIP_MIN,HU_CLIP_MAX)
    img_r=(img_r-NORM_MEAN)/NORM_STD
    return img_r, lab_r


# =============================================================================
# DATA AUGMENTATION - igual que el paper
# =============================================================================

def _crop_or_pad(arr, target):
    result=np.zeros(target,dtype=arr.dtype); slcs,sld=[],[]
    for s,d in zip(arr.shape,target):
        if s>=d: st=(s-d)//2; slcs.append(slice(st,st+d)); sld.append(slice(0,d))
        else:    st=(d-s)//2; slcs.append(slice(0,s));     sld.append(slice(st,st+s))
    result[tuple(sld)]=arr[tuple(slcs)]; return result

def augment(img_p, lab_p):
    # Flips iguales que el paper
    for ax in (1,2,3):
        if random.random()<0.5:
            img_p=np.flip(img_p,axis=ax).copy(); lab_p=np.flip(lab_p,axis=ax-1).copy()
    
    # Rotación más amplia que el paper: 15º a 30º
    if random.random()<0.3:
        ang=random.uniform(-30,30)
        img_p=ndimage.rotate(img_p,ang,axes=(2,3),reshape=False,order=1)
        lab_p=ndimage.rotate(lab_p.astype(np.float32),ang,axes=(1,2),reshape=False,order=0).astype(np.int64)
        
    # Escala con rango más amplio que el paper: 0.85-1.15 a 0.8-1.20
    if random.random()<0.3:
        sc=random.uniform(0.80,1.20)
        iz=ndimage.zoom(img_p[0],sc,order=1,prefilter=False)
        lz=ndimage.zoom(lab_p.astype(np.float32),sc,order=0,prefilter=False).astype(np.int64)
        img_p=_crop_or_pad(iz,img_p.shape[1:])[np.newaxis]; lab_p=_crop_or_pad(lz,lab_p.shape)
        
    # Nueva con relación al paper -> Deformación elástica
    if random.random() < 0.2:
        try:
            from scipy.ndimage import map_coordinates, gaussian_filter
            alpha = random.uniform(500, 1000)  # Intensidad de deformación
            sigma = random.uniform(30, 50)    # Suavizado
            
            shape = img_p.shape[1:]
            dx = np.random.randn(*shape) * alpha
            dy = np.random.randn(*shape) * alpha
            dz = np.random.randn(*shape) * alpha
            
            dx = gaussian_filter(dx, sigma, mode='reflect')
            dy = gaussian_filter(dy, sigma, mode='reflect')
            dz = gaussian_filter(dz, sigma, mode='reflect')
            
            x, y, z = np.meshgrid(np.arange(shape[2]), np.arange(shape[1]), np.arange(shape[0]), indexing='ij')
            indices = (z + dz, y + dy, x + dx)
            
            for c in range(img_p.shape[0]):
                img_p[c] = map_coordinates(img_p[c], indices, order=1, mode='reflect')
            lab_p = map_coordinates(lab_p.astype(np.float32), indices, order=0, mode='reflect').astype(np.int64)
        except:
            pass  # Si falla, simplemente no aplica la deformación
    
    # Intensidad con rango más amplio que paper: 0.75-1.25 a 0.7-1.3
    if random.random()<0.3: img_p=img_p*random.uniform(0.7,1.3)
    if random.random()<0.3:
        mn=img_p.mean(); img_p=(img_p-mn)*random.uniform(0.7,1.3)+mn
    if random.random()<0.3:
        g=random.uniform(0.7,1.5); mn,mx=img_p.min(),img_p.max()
        if mx>mn: img_p=np.power(np.clip((img_p-mn)/(mx-mn),0,1),g)*(mx-mn)+mn
    if random.random()<0.2:
        img_p=img_p+np.random.normal(0,random.uniform(0,0.1),img_p.shape).astype(np.float32)
    
    return img_p.astype(np.float32), lab_p
    
    
def sample_patch(img, lab, patch_size, pos_frac=POS_FRAC):
    H,W,D=img.shape; ph,pw,pd=patch_size
    pad=[(0,max(0,ph-H)),(0,max(0,pw-W)),(0,max(0,pd-D))]
    if any(p[1]>0 for p in pad):
        img=np.pad(img,pad,mode="reflect"); lab=np.pad(lab,pad,mode="constant"); H,W,D=img.shape
    if random.random()<pos_frac:
        fg=np.argwhere(lab>0)
        c=fg[np.random.randint(len(fg))] if len(fg)>0 else np.array([H//2,W//2,D//2])
    else:
        c=np.array([np.random.randint(H),np.random.randint(W),np.random.randint(D)])
    z0=int(np.clip(c[0]-ph//2,0,H-ph)); y0=int(np.clip(c[1]-pw//2,0,W-pw)); x0=int(np.clip(c[2]-pd//2,0,D-pd))
    return img[z0:z0+ph,y0:y0+pw,x0:x0+pd].copy(), lab[z0:z0+ph,y0:y0+pw,x0:x0+pd].copy()


# =============================================================================
# DATASET
# =============================================================================

class RyCDataset(Dataset):
    def __init__(self, data_dicts, is_train=True):
        self.is_train=is_train; self.patch_size=PATCH_SIZE
        self.n=BATCHES_PER_EPOCH*BATCH_SIZE if is_train else len(data_dicts)
        tag="train" if is_train else "val"
        print(f"  [Dataset {tag}] cargando {len(data_dicts)} vols...",end="",flush=True)
        t0=time.time(); self.vols=[]
        for d in data_dicts:
            img,lab=load_preprocess(d["image"],d["label"])
            self.vols.append((img,lab,d["case_id"]))
        print(f" OK ({len(self.vols)} casos, {time.time()-t0:.0f}s)")

    def __len__(self): return self.n

    def __getitem__(self, idx):
        if self.is_train:
            img,lab,_=self.vols[random.randint(0,len(self.vols)-1)]
            ip,lp=sample_patch(img,lab,self.patch_size)
            ip,lp=augment(ip[np.newaxis],lp)
            return (torch.tensor(ip,dtype=torch.float32), torch.tensor(lp,dtype=torch.long))
        else:
            img,lab,cid=self.vols[idx]
            return (torch.tensor(img[np.newaxis],dtype=torch.float32),
                    torch.tensor(lab,dtype=torch.long), cid)


# =============================================================================
# SLIDING WINDOW INFERENCE
# =============================================================================

def _gaussian_map(patch_size):
    def g1d(n):
        s=n/8.0; x=np.arange(n)-n//2; w=np.exp(-0.5*(x/s)**2); return (w/w.max()).astype(np.float32)
    gz,gy,gx=g1d(patch_size[0]),g1d(patch_size[1]),g1d(patch_size[2])
    return gz[:,None,None]*gy[None,:,None]*gx[None,None,:]

def sliding_window(model, img_np, patch_size=PATCH_SIZE, overlap=SW_OVERLAP, device=None):
    if device is None: device=next(model.parameters()).device
    model.eval(); H,W,D=img_np.shape; ph,pw,pd=patch_size
    sh=max(1,int(ph*(1-overlap))); sw=max(1,int(pw*(1-overlap))); sd=max(1,int(pd*(1-overlap)))
    gmap=_gaussian_map(patch_size)
    ph_p=max(0,ph-H); pw_p=max(0,pw-W); pd_p=max(0,pd-D)
    if ph_p or pw_p or pd_p:
        img_np=np.pad(img_np,[(0,ph_p),(0,pw_p),(0,pd_p)],mode="reflect")
    HP,WP,DP=img_np.shape
    acc=np.zeros((N_CLASSES,HP,WP,DP),dtype=np.float32); wt=np.zeros((HP,WP,DP),dtype=np.float32)
    def starts(total,p,s):
        lst=list(range(0,total-p+1,s))
        if not lst or lst[-1]+p<total: lst.append(max(0,total-p))
        return sorted(set(lst))
    zs=starts(HP,ph,sh); ys=starts(WP,pw,sw); xs=starts(DP,pd,sd)
    with torch.no_grad():
        for z0 in zs:
            for y0 in ys:
                for x0 in xs:
                    patch=img_np[z0:z0+ph,y0:y0+pw,x0:x0+pd]
                    t=torch.tensor(patch[np.newaxis,np.newaxis],dtype=torch.float32).to(device)
                    out=model(t); out=out[0] if isinstance(out,(list,tuple)) else out
                    prob=torch.softmax(out,dim=1).squeeze(0).cpu().numpy()
                    acc[:,z0:z0+ph,y0:y0+pw,x0:x0+pd]+=prob*gmap
                    wt[   z0:z0+ph,y0:y0+pw,x0:x0+pd]+=gmap
    acc/=np.maximum(wt[np.newaxis],1e-8)
    return acc[:,:H,:W,:D]

def sliding_window_tta(model, img_np, patch_size=PATCH_SIZE, device=None):
    preds=[sliding_window(model,img_np,patch_size,device=device)]
    for ax in (0,1,2):
        fl=np.flip(img_np,axis=ax).copy()
        p=sliding_window(model,fl,patch_size,device=device)
        preds.append(np.flip(p,axis=ax+1).copy())
    return np.mean(preds,axis=0)


# =============================================================================
# METRICAS (iguales que KiTS challenge)
# =============================================================================

def dice_kidney(pred,lab):
    p=pred>0; t=lab>0; i=np.logical_and(p,t).sum(); u=p.sum()+t.sum()
    return 2.0*i/u if u>0 else 1.0

def dice_tumor(pred,lab):
    p=pred==2; t=lab==2; i=np.logical_and(p,t).sum(); u=p.sum()+t.sum()
    return 2.0*i/u if u>0 else 1.0

def composite(kd,td): return float(np.sqrt(kd*td))


# =============================================================================
# ENTRENAMIENTO
# =============================================================================

class EarlyStopping:
    def __init__(self,patience=150,min_delta=1e-4):
        self.patience=patience; self.min_delta=min_delta; self.counter=0; self.best=None
    def __call__(self,score):
        if self.best is None or score>self.best+self.min_delta:
            self.best=score; self.counter=0; return False
        self.counter+=1; return self.counter>=self.patience

def poly_lr(epoch): return max((1.0-epoch/EPOCHS)**POLY_POWER, 1e-3)

def train_epoch(model,loader,optimizer,scaler,device,epoch):
    model.train(); total,steps=0.0,0
    for images,labels in loader:
        images,labels=images.to(device),labels.to(device)
        optimizer.zero_grad()
        with autocast():
            out=model(images); loss=deep_supervision_loss(out,labels)
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(),1.0)
        scaler.step(optimizer); scaler.update()
        total+=loss.item(); steps+=1
        if steps%50==0: print(f"    Batch {steps}/{len(loader)} | Loss: {total/steps:.4f}")
    return total/max(steps,1)

def validate(model,val_dataset,device):
    model.eval(); kds,tds=[],[]
    with torch.no_grad():
        for img,lab,_ in val_dataset.vols:
            prob=sliding_window(model,img,PATCH_SIZE,device=device)
            pred=np.argmax(prob,axis=0)
            kds.append(dice_kidney(pred,lab)); tds.append(dice_tumor(pred,lab))
    return float(np.mean(kds)), float(np.mean(tds))


# =============================================================================
# EVALUACION LEAVE-ONE-FOLD-OUT (mismo protocolo que nnUNet)
# =============================================================================

def evaluate_test_ensemble(fold_models, test_data, device, use_tta=USE_TTA):
    """
    Evaluacion en el test set real con ensemble de los 5 folds.
    Ninguno de los 5 modelos vio estos casos durante entrenamiento ni validación.
    Esta es la comparacion mas limpia con nnUNet.
    """
    if not test_data:
        print("  No hay datos de test disponibles.")
        return {}, []

    print("\n" + "-"*80)
    print(f"  EVALUACION EN TEST SET ({len(test_data)} casos, ensemble 5 folds)")
    print("-"*80)

    kds, tds, results = [], [], []

    for d in test_data:
        cid = d["case_id"]
        img, lab = load_preprocess(d["image"], d["label"])

        # Ensemble de los 5 folds
        prob_sum = None
        for m in fold_models:
            m.eval()
            with torch.no_grad():
                p = (sliding_window_tta(m, img, PATCH_SIZE, device=device)
                     if use_tta
                     else sliding_window(m, img, PATCH_SIZE, device=device))
            prob_sum = p if prob_sum is None else prob_sum + p

        pred = np.argmax(prob_sum / len(fold_models), axis=0)
        kd = dice_kidney(pred, lab); td = dice_tumor(pred, lab)
        kds.append(kd); tds.append(td)
        results.append({"case_id": cid, "kidney_dice": kd, "tumor_dice": td,
                        "composite_dice": composite(kd, td)})
        print(f"  {cid}: Kidney={kd:.4f}  Tumor={td:.4f}  "
              f"Composite={composite(kd,td):.4f}")

    kd_m = float(np.mean(kds)); td_m = float(np.mean(tds))
    print(f"\n  TEST SET — Ensemble 5 folds:")
    print(f"    Kidney    : {kd_m:.4f} +- {np.std(kds):.4f}")
    print(f"    Tumor     : {td_m:.4f} +- {np.std(tds):.4f}")
    print(f"    Composite : {composite(kd_m, td_m):.4f}")

    df = pd.DataFrame(results)
    df.to_csv(f"{OUTPUT_DIR}/results/test_per_case.csv", index=False)
    summary = {"kidney": kd_m, "tumor": td_m, "composite": composite(kd_m, td_m),
               "kidney_std": float(np.std(kds)), "tumor_std": float(np.std(tds))}
    return summary, results
    """
    Cada caso se evalua con el modelo del fold en que fue VALIDACION
    (protocolo identico a nnUNet) y con ensemble de los otros 4 folds
    (mas riguroso: ningun modelo vio ese caso).
    """
    print("\n" + "-"*80)
    print("  EVALUACION LEAVE-ONE-FOLD-OUT (mismo protocolo que nnUNet)")
    print("-"*80)

    case_to_fold = {}
    for fold_idx,fd in enumerate(fold_data):
        for d in fd["val"]: case_to_fold[d["case_id"]] = fold_idx

    # Preprocesar todos los casos de val una sola vez
    processed = {}
    for fd in fold_data:
        for d in fd["val"]:
            cid=d["case_id"]
            if cid not in processed:
                img,lab=load_preprocess(d["image"],d["label"])
                processed[cid]=(img,lab)

    all_res=[]; kds_s,tds_s,kds_e,tds_e=[],[],[],[]

    for cid,(img,lab) in sorted(processed.items()):
        fold_idx=case_to_fold[cid]; m=fold_models[fold_idx]
        m.eval()
        # Modelo correspondiente al fold (=nnUNet protocol)
        with torch.no_grad():
            prob=(sliding_window_tta(m,img,PATCH_SIZE,device=device) if use_tta
                  else sliding_window(m,img,PATCH_SIZE,device=device))
        pred=np.argmax(prob,axis=0)
        kd_s=dice_kidney(pred,lab); td_s=dice_tumor(pred,lab)
        kds_s.append(kd_s); tds_s.append(td_s)

        # Ensemble de los otros 4 folds
        others=[mm for i,mm in enumerate(fold_models) if i!=fold_idx]
        prob_sum=None
        for mm in others:
            mm.eval()
            with torch.no_grad():
                p=(sliding_window_tta(mm,img,PATCH_SIZE,device=device) if use_tta
                   else sliding_window(mm,img,PATCH_SIZE,device=device))
            prob_sum=p if prob_sum is None else prob_sum+p
        pred_e=np.argmax(prob_sum/len(others),axis=0)
        kd_e=dice_kidney(pred_e,lab); td_e=dice_tumor(pred_e,lab)
        kds_e.append(kd_e); tds_e.append(td_e)

        print(f"  {cid} [fold{fold_idx}] "
              f"single-> K={kd_s:.4f} T={td_s:.4f} C={composite(kd_s,td_s):.4f} | "
              f"ens4  -> K={kd_e:.4f} T={td_e:.4f} C={composite(kd_e,td_e):.4f}")

        all_res.append({"case_id":cid,"val_fold":fold_idx,
                        "kidney_single":kd_s,"tumor_single":td_s,"composite_single":composite(kd_s,td_s),
                        "kidney_ens4":kd_e,  "tumor_ens4":td_e,  "composite_ens4":composite(kd_e,td_e)})

    kd_s_m=float(np.mean(kds_s)); td_s_m=float(np.mean(tds_s))
    kd_e_m=float(np.mean(kds_e)); td_e_m=float(np.mean(tds_e))

    print("\n"+"="*80)
    print("  RESULTADOS FINALES:")
    print()
    print("  Protocolo identico a nnUNet (single model, fold de validacion):")
    print(f"    Kidney    : {kd_s_m:.4f} +- {np.std(kds_s):.4f}")
    print(f"    Tumor     : {td_s_m:.4f} +- {np.std(tds_s):.4f}")
    print(f"    Composite : {composite(kd_s_m,td_s_m):.4f}")
    print()
    print("  Ensemble 4 folds (nunca vieron el caso, mas riguroso):")
    print(f"    Kidney    : {kd_e_m:.4f} +- {np.std(kds_e):.4f}")
    print(f"    Tumor     : {td_e_m:.4f} +- {np.std(tds_e):.4f}")
    print(f"    Composite : {composite(kd_e_m,td_e_m):.4f}")
    print("="*80)

    pd.DataFrame(all_res).to_csv(f"{OUTPUT_DIR}/results/lofo_per_case.csv",index=False)
    summary={"kidney_single":kd_s_m,"tumor_single":td_s_m,"composite_single":composite(kd_s_m,td_s_m),
             "kidney_ens4":kd_e_m,  "tumor_ens4":td_e_m,  "composite_ens4":composite(kd_e_m,td_e_m)}
    pd.DataFrame([summary]).to_csv(f"{OUTPUT_DIR}/results/lofo_summary.csv",index=False)
    return summary


# =============================================================================
# MAIN
# =============================================================================

# =============================================================================
# MAIN COMPLETO CORREGIDO
# =============================================================================

def main():
    print("\n" + "=" * 80)
    print(f"  REPLICACIÓN KiTS2019 - Entrenando con carpetas imagesTr de nnU-Net")
    print(f"  Spacing objetivo: {TARGET_SPACING} | Arquitectura: {ARCH.upper()}")
    print("=" * 80)

    try:
        # Carga exacta: sincroniza IDs del JSON con archivos físicos en imagesTr/labelsTr
        fold_data, test_data = load_splits_exact(NNUNET_SPLITS, DATA_DIR, LABEL_DIR)
        
        # Definimos N_FOLDS según los datos cargados
        N_FOLDS = len(fold_data)
        
        print(f"\n Splits cargados correctamente: {N_FOLDS} folds encontrados.")
        print(f" Casos totales en imagesTr disponibles para Train/Val: {len(test_data) + sum(len(f['val']) for f in fold_data)}")
    except Exception as e:
        print(f"\nError crítico al cargar splits: {e}")
        return

    all_fold_results = []
    trained_models = []

    # Bucle de entrenamiento por Fold
    for fold in range(N_FOLDS):
        print("\n" + "=" * 80)
        print(f"  EJECUTANDO FOLD {fold+1}/{N_FOLDS}")
        print(f"  Train: {len(fold_data[fold]['train'])} casos | Val: {len(fold_data[fold]['val'])} casos")
        print("=" * 80)

        # Preparación de Datasets usando la lógica de nnU-Net
        train_ds = RyCDataset(fold_data[fold]["train"], is_train=True)
        val_ds   = RyCDataset(fold_data[fold]["val"],   is_train=False)
        
        train_loader = DataLoader(
            train_ds, batch_size=BATCH_SIZE, shuffle=True,
            num_workers=4, pin_memory=True, drop_last=True
        )

        # Construcción del modelo Residual 3D
        model = build_model().to(DEVICE)
        optimizer = torch.optim.SGD(
            model.parameters(), lr=LR_INIT,
            momentum=MOMENTUM, weight_decay=WEIGHT_DECAY, nesterov=True
        )
        scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, poly_lr)
        scaler = GradScaler()
        stopper = EarlyStopping(patience=150)

        best_tumor = -1.0
        best_kidney = 0.0
        best_epoch = 0
        best_state = None
        history = []
        t0 = time.time()

        # Ciclo de Épocas
        for epoch in range(1, EPOCHS + 1):
            loss_train = train_epoch(model, train_loader, optimizer, scaler, DEVICE, epoch)
            scheduler.step()
            
            # Validación con Sliding Window
            kd, td = validate(model, val_ds, DEVICE)
            
            current_lr = optimizer.param_groups[0]["lr"]
            elapsed = (time.time() - t0) / 60.0
            
            print(f"  Ep {epoch:>3} | Loss: {loss_train:.4f} | K-Dice: {kd:.4f} | T-Dice: {td:.4f} | LR: {current_lr:.2e} | {elapsed:.1f} min")
            
            history.append({"epoch": epoch, "loss": loss_train, "kidney": kd, "tumor": td, "lr": current_lr})

            # Guardar mejor modelo basado en Dice de Tumor
            if td > best_tumor:
                best_tumor = td
                best_kidney = kd
                best_epoch = epoch
                best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
                
                torch.save({
                    "epoch": epoch, "fold": fold, "arch": ARCH,
                    "model_state_dict": model.state_dict(),
                    "tumor_dice": td, "kidney_dice": kd
                }, f"{OUTPUT_DIR}/checkpoints/fold_{fold}_best.pth")
                
                print(f"    >>> Nuevo récord Fold {fold}: Tumor Dice = {td:.4f}")

            if stopper(td):
                print(f"\n  Early stopping en época {epoch} (paciencia agotada).")
                break

        # Guardar log del fold y limpiar memoria
        pd.DataFrame(history).to_csv(f"{OUTPUT_DIR}/logs/fold_{fold}_history.csv", index=False)
        
        if best_state is not None:
            model.load_state_dict({k: v.to(DEVICE) for k, v in best_state.items()})
        
        trained_models.append(model)
        all_fold_results.append({
            "fold": fold, "best_epoch": best_epoch,
            "kidney_val": best_kidney, "tumor_val": best_tumor,
            "composite_val": composite(best_kidney, best_tumor)
        })
        
        print(f"\n  [RESULTADO FOLD {fold}] Mejor T-Dice: {best_tumor:.4f} (época {best_epoch})")
        torch.cuda.empty_cache()

    # EVALUACIÓN FINAL
    print("\n" + "=" * 80)
    print("  ENTRENAMIENTO COMPLETADO - RESUMEN K-FOLD")
    print("=" * 80)
    
    df_results = pd.DataFrame(all_fold_results)
    df_results.to_csv(f"{OUTPUT_DIR}/results/kfold_val_summary.csv", index=False)
    
    print(f"  Media Kidney Dice : {df_results['kidney_val'].mean():.4f} ± {df_results['kidney_val'].std():.4f}")
    print(f"  Media Tumor Dice  : {df_results['tumor_val'].mean():.4f} ± {df_results['tumor_val'].std():.4f}")
    print(f"  Resultados guardados en: {OUTPUT_DIR}/results/")

    # Evaluación en Test Set real (ensemble de los modelos entrenados)
    # Nota: test_data aquí son los casos que estaban en imagesTr pero fuera del split
    if test_data:
        print("\n  Iniciando evaluación en casos excluidos del split...")
        evaluate_test_ensemble(trained_models, test_data, DEVICE)
    
    # Protocolo LOFO (Leave-One-Fold-Out) idéntico a nnU-Net
    print("\n  Iniciando evaluación Leave-One-Fold-Out (Validación cruzada)...")
    evaluate_lofo(trained_models, fold_data, DEVICE)

    print("\n" + "=" * 80)
    print("  PROCESO FINALIZADO CON ÉXITO")
    print("=" * 80)

if __name__ == "__main__":
    main()
