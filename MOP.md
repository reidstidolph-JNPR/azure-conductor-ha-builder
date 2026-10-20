# MOP: Highly available SSR conductor in Azure

This procedure deploys a two-node highly available Session Smart conductor (node0 and node1) in Azure from the BYOL marketplace image, using an ARM template, a parameters file per node and a cloud-init file per node. Allow 60-90 minutes, most of it waiting for the SSR software to install on each node.

## Environment

| Item | Value |
|---|---|
| Resource group | `<input-your-resource-group>` |
| Region | `<input-your-azure-region>` |
| VNet / subnet | `<input-your-vnet-name>` / `<input-your-subnet-name>` |
| node0 | VM `conductor-node0`, IP `<input-node0-private-ip>`, zone 1 |
| node1 | VM `conductor-node1`, IP `<input-node1-private-ip>`, zone 2 |
| Public IPs | no |
| Conductor name | `Conductor` |
| SSR version | `7.2.3` |

## Prerequisites

- The resource group, VNet, subnet and managed identity listed above exist. The two node IPs are free in the subnet.
- The subnet has outbound HTTPS access to download the SSR software, and allows traffic between the two nodes.
- Azure Cloud Shell (PowerShell) with permission to deploy to the resource group and to run `az vm run-command`.
- The five deployment files below, uploaded to one Cloud Shell directory (Manage files > Upload). Run every command from that directory.

## Files

| File | Purpose |
|---|---|
| `conductor_template.json` | ARM template for one conductor node (deployed once per node) |
| `conductor-node0-params.json` / `conductor-node1-params.json` | Template parameters for node0 / node1 |
| `conductor-node0-cloud-init.txt` / `conductor-node1-cloud-init.txt` | cloud-init with the SSR onboarding configuration for node0 / node1 |

> The cloud-init files contain the repository token and a temporary password. Keep them private and delete them from Cloud Shell when the procedure is complete.

## Procedure

Each command is a single line for Azure Cloud Shell (PowerShell). Copy the whole line.

### Step 1: Confirm the Azure subscription

Make sure Cloud Shell targets the subscription that contains the resource group. If not, run `az account set --subscription <name-or-id>`.

```powershell
az account show --query '[name, id]' --output 'tsv'
```

Expected: The target subscription name and ID.

### Step 2: Accept the marketplace image terms

Required once per subscription for the BYOL image. Safe to repeat.

```powershell
az vm image terms accept --publisher 'juniper-networks' --offer 'session-smart-networking-payg' --plan 'session-smart-networking-public-gen2-byol' --query 'accepted' --output 'tsv'
```

Expected: `true`

### Step 3: Deploy node0

Creates conductor-node0 from the template. The cloud-init file is passed as the template's `customData` parameter.

```powershell
az deployment group create --resource-group '<input-your-resource-group>' --name 'ssr-conductor-node0' --template-file 'conductor_template.json' --parameters '@conductor-node0-params.json' 'customData=@conductor-node0-cloud-init.txt' --query 'properties.provisioningState' --output 'tsv'
```

Expected: `Succeeded` (after a few minutes). SSR installation then continues on the VM.

### Step 4: Wait until node0 is initialized

The VM downloads and installs SSR, initializes the conductor and reboots. This usually takes 20-40 minutes. Repeat the command every 5 minutes. Do not continue until the state is READY.

```powershell
az vm run-command invoke --resource-group '<input-your-resource-group>' --name 'conductor-node0' --command-id 'RunShellScript' --scripts 'if systemctl is-active --quiet 128T-hardware-bootstrapper; then echo STATE=BOOTSTRAPPING; elif systemctl is-failed --quiet 128T-hardware-bootstrapper; then echo STATE=FAILED; elif test -f /etc/128technology/global.init && systemctl is-active --quiet 128T; then echo STATE=READY; else echo STATE=INSTALLING; fi; cat /etc/128technology/global.init 2>/dev/null; echo' --query 'value[0].message' --output 'tsv'
```

Expected: `STATE=READY`, followed by the global.init content listing conductor `node0`. `STATE=FAILED` means the bootstrapper failed (see Troubleshooting).

### Step 5: Open temporary HA peer access on node0

Lets node1 (<input-node1-private-ip>) log in to node0 as t128 with the temporary HA peer password, which the initializer on node1 needs to learn the conductor setup from node0. It sets the temporary password, makes sudo prompt for it, and allows SSH password login for t128 only from node1. This automates "Configure Node A" in the Conductor HA for Cloud Deployments documentation. Step 8 reverts it.

```powershell
az vm run-command invoke --resource-group '<input-your-resource-group>' --name 'conductor-node0' --command-id 'RunShellScript' --scripts 'set -e; echo ''t128:<input-temporary-ha-peer-password>'' | chpasswd; usermod -aG wheel t128; if test -f /etc/sudoers.d/90-cloud-init-users; then mv /etc/sudoers.d/90-cloud-init-users /root/90-cloud-init-users.ha-peer; fi; echo ''%wheel ALL=(ALL) ALL'' > /etc/sudoers.d/91-ha-peer; chmod 440 /etc/sudoers.d/91-ha-peer; visudo -cq; sed -i --follow-symlinks ''/^# BEGIN ha-peer$/,/^# END ha-peer$/d'' /etc/ssh/sshd_config; printf ''%s\n'' ''# BEGIN ha-peer'' ''Match User t128 Address <input-node1-private-ip>/32'' ''    PasswordAuthentication yes'' ''# END ha-peer'' >> /etc/ssh/sshd_config; sshd -t; systemctl reload sshd; if sudo -l -U t128 | grep -q NOPASSWD; then echo ERROR_NOPASSWD_SUDO_REMAINS; else echo HA_PEER_ACCESS_OPEN; fi' --query 'value[0].message' --output 'tsv'
```

Expected: `HA_PEER_ACCESS_OPEN`

### Step 6: Deploy node1

Creates conductor-node1. Its initializer joins node0 using the temporary credentials.

```powershell
az deployment group create --resource-group '<input-your-resource-group>' --name 'ssr-conductor-node1' --template-file 'conductor_template.json' --parameters '@conductor-node1-params.json' 'customData=@conductor-node1-cloud-init.txt' --query 'properties.provisioningState' --output 'tsv'
```

Expected: `Succeeded`

### Step 7: Wait until node1 has joined

Repeat every 5 minutes (20-40 minutes). Do not continue until node1 is READY and its global.init lists both conductors.

```powershell
az vm run-command invoke --resource-group '<input-your-resource-group>' --name 'conductor-node1' --command-id 'RunShellScript' --scripts 'if systemctl is-active --quiet 128T-hardware-bootstrapper; then echo STATE=BOOTSTRAPPING; elif systemctl is-failed --quiet 128T-hardware-bootstrapper; then echo STATE=FAILED; elif test -f /etc/128technology/global.init && systemctl is-active --quiet 128T; then echo STATE=READY; else echo STATE=INSTALLING; fi; cat /etc/128technology/global.init 2>/dev/null; echo' --query 'value[0].message' --output 'tsv'
```

Expected: `STATE=READY`, and global.init lists `node0` and `node1` with their IP addresses.

### Step 8: Close HA peer access on node0

Removes the SSH password exception, restores the original sudo rules, and resets t128 to the password from the onboarding configuration. The temporary password stops working.

```powershell
az vm run-command invoke --resource-group '<input-your-resource-group>' --name 'conductor-node0' --command-id 'RunShellScript' --scripts 'set -e; sed -i --follow-symlinks ''/^# BEGIN ha-peer$/,/^# END ha-peer$/d'' /etc/ssh/sshd_config; sshd -t; systemctl reload sshd; rm -f /etc/sudoers.d/91-ha-peer; if test -f /root/90-cloud-init-users.ha-peer; then mv /root/90-cloud-init-users.ha-peer /etc/sudoers.d/90-cloud-init-users; fi; visudo -cq; usermod -p ''<input-sha512-crypt-hash-of-t128-password>'' t128; echo HA_PEER_ACCESS_CLOSED' --query 'value[0].message' --output 'tsv'
```

Expected: `HA_PEER_ACCESS_CLOSED`

### Step 9: Restart node0

node0 must restart to recognize node1.

```powershell
az vm restart --resource-group '<input-your-resource-group>' --name 'conductor-node0'
```

Expected: The command returns without error.

### Step 10: Verify the HA pair

Wait about 5 minutes, then check node0. Finally log in to the PCLI on either node (SSH as t128, then `sudo su - admin`) and run `show system connectivity`: both nodes must be connected.

```powershell
az vm run-command invoke --resource-group '<input-your-resource-group>' --name 'conductor-node0' --command-id 'RunShellScript' --scripts 'if systemctl is-active --quiet 128T-hardware-bootstrapper; then echo STATE=BOOTSTRAPPING; elif systemctl is-failed --quiet 128T-hardware-bootstrapper; then echo STATE=FAILED; elif test -f /etc/128technology/global.init && systemctl is-active --quiet 128T; then echo STATE=READY; else echo STATE=INSTALLING; fi; cat /etc/128technology/global.init 2>/dev/null; echo' --query 'value[0].message' --output 'tsv'
```

Expected: `STATE=READY`, and global.init lists `node0` and `node1`.

## Rollback

To remove a node (for example to retry it), delete its resources. Re-run the procedure from that node's deploy step. If node1 is removed after it joined, also remove it from node0 before redeploying.

```powershell
az vm delete --resource-group '<input-your-resource-group>' --name 'conductor-node1' --yes; az network nic delete --resource-group '<input-your-resource-group>' --name 'conductor-node1-control'; az network nsg delete --resource-group '<input-your-resource-group>' --name 'conductor-node1-control'; az disk delete --resource-group '<input-your-resource-group>' --name 'conductor-node1' --yes
az vm delete --resource-group '<input-your-resource-group>' --name 'conductor-node0' --yes; az network nic delete --resource-group '<input-your-resource-group>' --name 'conductor-node0-control'; az network nsg delete --resource-group '<input-your-resource-group>' --name 'conductor-node0-control'; az disk delete --resource-group '<input-your-resource-group>' --name 'conductor-node0' --yes
```

## Troubleshooting

- Bootstrapper log (download, install, onboarding): `/var/log/128T-hardware-bootstrapper/128T-hardware-bootstrapper.log`
- Initializer log (conductor and HA setup): `/var/log/128technology/initializer.log`
- cloud-init log: `/var/log/cloud-init-output.log`
- Read a log without SSH: replace the `--scripts` value of the status command with `'tail -n 50 <log file>'`.
- `ERROR_NOPASSWD_SUDO_REMAINS` in step 5: another sudoers rule gives t128 passwordless sudo. Remove it, then repeat step 5.
- node1 fails with `Invalid credentials` in the initializer log: step 5 was not completed before node1 initialized, or the subnet blocks traffic between the nodes. Fix the cause, roll back node1, then repeat steps 5-7.
