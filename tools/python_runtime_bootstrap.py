"""Make NVIDIA runtime wheels discoverable by CTranslate2 on Windows."""
import os
from pathlib import Path
import site

_dll_handles = []


def register_nvidia_dlls():
    if os.name != "nt":
        return []
    directories = []
    for root in site.getsitepackages():
        for component in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"):
            for subdir in ("bin", "lib"):
                directory = Path(root) / "nvidia" / component / subdir
                if directory.is_dir():
                    directories.append(str(directory))
        torch_lib = Path(root) / "torch" / "lib"
        if torch_lib.is_dir():
            directories.append(str(torch_lib))
    directories = list(dict.fromkeys(directories))
    for directory in directories:
        _dll_handles.append(os.add_dll_directory(directory))
    os.environ["PATH"] = os.pathsep.join(directories + [os.environ.get("PATH", "")])
    return directories
