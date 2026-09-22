# `virt/` — the GMX export, in a box

`game/BarkleyV120.gmx` was made by hand: run a Java GUI decompiler on the
original executable, then open the `.gm6` it produces in GameMaker: Studio
1.4.9999 and save it out as a GMX. This directory does the same thing without a
person at the keyboard.

Only the second half needs Windows, so only the second half gets a VM:

```
BarkleyV120.exe
   |  the GM6 decompiler (game/original/GMDecompilerDecompiled), headless,
   |  in a container on the host -- no VM, about 75 seconds
   v
BarkleyV120.gm6
   |  GameMaker: Studio 1.4.9999, driven through its own windows,
   |  in a throwaway Windows 10 VM
   v
BarkleyV120.gmx
```

One command:

```sh
virt/run.sh
```

It decompiles on the host, caches the pinned downloads, starts the file service
the guest pulls from, brings the VM up, provisions it and runs the GameMaker
half inside it. The export lands on the host as `build/virt/BarkleyV120.gmx.zip`.

Step 1 on its own, which is worth knowing about because it needs none of the
rest:

```sh
virt/decompile.sh [out.gm6]      # -> build/virt/BarkleyV120.gm6
```

## What you need

- **podman** or **docker**, for step 1. `virt/decompile.sh` prefers podman and
  takes `BARKLEY_CONTAINER` to override.
- **Vagrant** with the **vagrant-qemu** plugin (`vagrant plugin install vagrant-qemu`).
- **QEMU**. On an Intel Mac running a recent macOS, Homebrew has no bottle for
  it and builds from source for the better part of an hour, so use MacPorts:
  `sudo port install qemu`. `virt/vagrant.sh` finds it under `/opt/local`,
  `/usr/local` or `/opt/homebrew`, or takes `QEMU_PREFIX`.
- **Node 22+** — the host side is two small scripts with no dependencies.
- The inputs, which are untracked and have to be in place:
  `tools/GameMaker-Studio-(SimonElJoyas).zip`, `game/original/BarkleyV120.exe`
  and `game/original/GMDecompilerDecompiled/`.
- About **40 GB** of disk (a 17 GB box plus the machine's overlay) and an
  hour for a first run, most of it Windows booting and GameMaker importing.
- An internet connection for the first run: the box, the JDK image and the
  Visual C++ runtime.

If `tools/` and `game/` live in another checkout (they are untracked, so a git
worktree does not have them), point `BARKLEY_ROOT` at the one that does.

## The pieces

| | |
|---|---|
| `decompile.sh` | step 1, on the host: the exe to a `.gm6`, in a container |
| `java/Decompile.java` | the decompiler's "GM6 EXE" path with the window left out |
| `Vagrantfile` | the VM: `gusztavvargadr/windows-10` on QEMU with the host's accelerator |
| `vagrant.sh` | vagrant with QEMU on PATH and `BARKLEY_ROOT` set — use it instead of bare `vagrant` |
| `run.sh` | the whole pipeline, one command |
| `winrm.sh` | run a command in the guest, or a script on its desktop (`--session`), or re-push the guest scripts (`--sync`) |
| `screenshot.sh` | photograph the screen through the QEMU monitor, below Windows |
| `monitor.sh` | send any QEMU monitor command (`system_reset`, `sendkey ret`, …) |
| `host/serve.mjs` | the guest's window onto the host: files in, results out |
| `host/prepare.mjs` | fetches and hash-checks the pinned third-party downloads into `cache/` |
| `provision/01-bootstrap.ps1` | stage 1: lay out `C:\barkley`, unpack everything, make the machine sit still |
| `guest/` | everything that runs inside Windows (mirrored to `C:\barkley\guest`) |

## How the guest is driven

Two channels, because one is not enough:

**WinRM**, for everything that does not need a screen. Vagrant runs it as
SYSTEM in session 0, which has no desktop at all.

**The logged-on desktop**, for everything that does. `Invoke-InSession`
(`guest/lib.ps1`) writes a wrapper script, registers it as a scheduled task
whose principal is the interactive user, runs it, and waits for the exit code it
leaves behind. That is what puts a script on the same window station as the
GameMaker IDE, so its windows can be found and its buttons pressed.

The guest reaches the host at **10.0.2.2**, the SLIRP gateway, where
`host/serve.mjs` serves `tools/`, `game/original/`, `virt/guest/`, `virt/cache/`
and `build/virt/` (as `build/`, which is how the `.gm6` gets in), and takes
uploads into `build/virt/`. vagrant-qemu has no synced folders, so this is the
only road in and out.

`virt/winrm.sh --sync` re-pushes `guest/` without a full re-provision. It is a
mirror: a script deleted on the host is deleted in the VM too.

To see what a GUI step is facing:

```sh
virt/winrm.sh --session probe.ps1      # windows + a screenshot in build/virt/shots/
virt/winrm.sh --session launch.ps1 'C:\path\to.exe' 40 mylabel
virt/winrm.sh 'powershell -NoProfile -File C:\barkley\guest\trace.ps1'   # what the IDE says
```

## Steps

**1. `decompile.sh` — the exe to a `.gm6`.** On the host, in a Temurin 8
container. Compiles the decompiler from the sources in
`game/original/GMDecompilerDecompiled` together with `java/Decompile.java`,
which is the GUI's "GM6 EXE" path with the window left out, and checks the
result's SHA-256 — byte-for-byte the `.gm6` the Java GUI produced by hand
(`4b76af44…`, 10,720,322 bytes).

Three things make this work: the decompiler reads its input path out of a Swing
text field (`GmDecompiler.sourceField`), which the launcher fills in instead of
building a window; the JVM runs with `-Djava.awt.headless=true`, without which
it sits forever waiting for a display; and it is Java 8 exactly, because
`ProgressDialogListener` calls `Thread.stop()`, removed in 20.

The work happens on the container's own filesystem, not on the bind mount. The
decompiler writes its output a few bytes at a time, and through virtiofs on
macOS that runs at about a fifth of the speed for a twentieth of the CPU.

**2. `guest/features.ps1` and `guest/crack.ps1` — GameMaker.** DirectPlay
first: the patcher is a GameMaker 8.1 game, and without it Windows stops the
launch with a modal "needs the following Windows feature" dialog. Then the steps
from the video in `tools/`: run the IDE once so it writes its profile, then the
Universal GameMaker Patcher, which puts a cracked `libeay32.dll` in place and
writes `licence.plist`. The patcher is itself a fullscreen GameMaker game, so
its buttons are found by colour (`guest/screen.ps1`) rather than by control name.

**3. `guest/export.ps1` — the `.gm6` to a `.gmx`.** Drives the IDE's
File → Import Project, which is the only way in: GameMaker Studio 1.4 has no
command line for it.

## Gotchas

- **The guest bugchecks under load, it is the hypervisor, and this is not
  solved.** Fifteen bugchecks in an hour on the first serious run, four more in
  ten minutes on the second: `0xA` mostly, always a read of a wild address at
  DISPATCH_LEVEL; `0xD1` whose faulting address is in pool rather than in any
  loaded module; and a `0x1E` whose first argument was `0xc000001d`,
  STATUS_ILLEGAL_INSTRUCTION *in kernel mode*. Kernel code being sent to an
  instruction the CPU rejects is guest state being corrupted underneath Windows,
  not a driver fault.

  Two theories are already dead, and it is worth not repeating them:

  - **Not TSX.** Ten of the first fifteen arrived after `-hle,-rtm` went in.
  - **Not SMP.** Four more arrived inside ten minutes on `-smp 1`.

  So every knob is an environment variable now, and the next hypothesis is one
  `virt/vagrant.sh reload` away (the command line is built when the machine
  starts, so nothing less than a reload counts):

  | | |
  |---|---|
  | `BARKLEY_VM_CPU` | a named model (`Penryn`, `Nehalem`, …) asks HVF for a far smaller feature set than `host`. UTM's own default for x86\_64 is `Penryn`. |
  | `BARKLEY_VM_ACCEL` | `tcg` emulates instead of accelerating: slow, but it is the test that says whether HVF is at fault at all |
  | `BARKLEY_VM_NET` | `e1000` is the older and much more exercised of the two NIC emulations |
  | `BARKLEY_VM_CPUS`, `BARKLEY_VM_MEMORY` | as they sound |

  Moving the decompile out of the VM helped for the same reason it helped
  everywhere else: it was the heaviest load in the pipeline and the one that
  triggered this most reliably.

  **Read the history rather than guessing.** A bugcheck here looks exactly like
  a hang from the host — the VM sits at ~100% CPU writing its dump, and
  `vagrant` eventually reports a WinRM timeout. The guest knows better:

  ```sh
  virt/winrm.sh "Get-WinEvent -FilterHashtable @{LogName='System';Id=1001} -MaxEvents 5 | Format-List TimeCreated,Message"
  virt/winrm.sh '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime'
  ```

  A `LastBootUpTime` more recent than the run began means it crashed and came
  back, which is easy to miss: the machine reboots itself and WinRM answers
  again as though nothing happened.
- **`screenshot.sh` can kill the VM.** Forcing a VGA refresh under HVF trips a
  QEMU assertion (`do_hv_vm_protect`) and aborts the process, about one call in
  five. Nothing is lost -- `virt/vagrant.sh up` boots it again -- but prefer
  `--session probe.ps1`, which takes the picture from inside Windows.
- **`GameMaker-Studio.exe` is not the IDE.** It is a Sparkle auto-updater: its
  `.exe.config` names `ExeName` `5piceIDE.exe` and a supported runtime of
  `v2.0.50727`, so being .NET 2.0 it will not start until .NET Framework 3.5 is
  installed — which on Windows 10 means a DISM run against Windows Update that
  took over an hour here and never finished. `5piceIDE.exe` is the IDE proper,
  it is native Delphi, and it needs none of that. Start it directly.
- **`5piceIDE.exe` needs the 32-bit Visual C++ runtime.** Without it Windows
  answers the launch with "VCRUNTIME140.dll was not found" and nothing starts.
  `prepare.mjs` pins `VC_redist.x86.exe` and stage 1 installs it.
- **An unlicensed IDE closes itself.** `TraceIDE.log` ends `Close button clicked
  on Welcome Screen - shutting down`: the CEF welcome screen gives up and takes
  the process with it, leaving no window and no error. `guest/trace.ps1` prints
  that log, and it is the first thing to read when the IDE "does nothing".
- **Vagrant's port-collision check is broken on macOS.** It tests a port with
  `Socket.tcp(host, port, connect_timeout:)`, which on macOS returns a socket
  even for a refused connection, so every port looks busy and `vagrant up` stops
  before it starts. The Vagrantfile replaces `is_port_open?` with a plain
  blocking connect.
- **The box's own Vagrantfile raises** unless it can find OVMF firmware at a
  Linux path. Vagrant evaluates that block even without vagrant-libvirt
  installed, so the Vagrantfile points `VAGRANT_LIBVIRT_OVMF_CODE` at the
  firmware it already found.
- **`qemu-img` has to be on PATH**: vagrant-qemu uses `qemu_bin` for the VM but
  shells out to a bare `qemu-img` to make the machine's disk. `vagrant.sh` does
  this.
- **Do not declare the WinRM or RDP forwarded ports.** Vagrant defines the
  first and the box defines the second; a second entry for the same host port
  reads as a collision with itself.
- **DISM will not run over WinRM** -- `Enable-WindowsOptionalFeature` answers
  "Access is denied" whatever the account -- so DirectPlay goes through the
  session like the GUI work.
- **UAC is off and the recovery screen is disabled** in the guest. A UAC consent
  prompt lives on the secure desktop, where no amount of SendKeys reaches it;
  and two interrupted boots are enough for Windows to hand the machine to WinRE,
  where there is no WinRM and no way back without a person at the keyboard.
- **A killed `vagrant` leaves its guest-side shell running**, holding
  `C:\tmp\vagrant-shell.ps1` open, and the next provision blocks on the upload.
  Reboot the guest (`virt/vagrant.sh reload`) rather than waiting.
- **The machine state lives in `virt/.vagrant/`** (the overlay disk, the UEFI
  variable store). `virt/vagrant.sh destroy -f` throws it away; the 17 GB box
  itself stays in `~/.vagrant.d/boxes`.
