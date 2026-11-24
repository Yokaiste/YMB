use super::*;
use std::io::{Seek, SeekFrom};

const MAGIC: &[u8; 16] = b"YMB-DEPLOY-V1\0\0\0";
const TRAILER: u64 = 88;

pub fn read(path: &Path) -> Result<Option<Installer>> {
    let mut file = fs::File::open(path).map_err(|e| Diagnostic::io(path, e))?;
    let length = file.metadata().map_err(|e| Diagnostic::io(path, e))?.len();
    if length < TRAILER {
        return Ok(None);
    }
    file.seek(SeekFrom::End(-(TRAILER as i64)))
        .map_err(|e| Diagnostic::io(path, e))?;
    let mut trailer = [0; TRAILER as usize];
    file.read_exact(&mut trailer)
        .map_err(|e| Diagnostic::io(path, e))?;
    if &trailer[72..] != MAGIC {
        return Ok(None);
    }
    let size = u64::from_le_bytes(trailer[64..72].try_into().unwrap());
    if size > 1024 * 1024 || size > length - TRAILER {
        return Err(error(crate::messages::text(
            "deploy.payload.read.invalid_deploy_configuration_length",
        )));
    }
    file.seek(SeekFrom::Start(length - TRAILER - size))
        .map_err(|e| Diagnostic::io(path, e))?;
    let mut data = vec![0; size as usize];
    file.read_exact(&mut data)
        .map_err(|e| Diagnostic::io(path, e))?;
    if ymb_core::hash(&data).as_bytes() != &trailer[..64] {
        return Err(error(crate::messages::text(
            "deploy.payload.read.deploy_configuration_checksum_mismatch",
        )));
    }
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(|e| error(e.to_string()))
}

pub fn write(builder: &Path, target: &Path, installer: &Installer) -> Result<()> {
    if read(builder)?.is_some() {
        return Err(error(crate::messages::text(
            "deploy.payload.write.use_an_ordinary_ymb_executable_to_create",
        )));
    }
    let data = serde_json::to_vec(installer).map_err(|e| error(e.to_string()))?;
    if data.len() > 1024 * 1024 {
        return Err(error(crate::messages::text(
            "deploy.payload.write.deploy_configuration_exceeds_1_mib",
        )));
    }
    paths::copy_atomic(builder, target)?;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(target)
        .map_err(|e| Diagnostic::io(target, e))?;
    for bytes in [
        data.as_slice(),
        ymb_core::hash(&data).as_bytes(),
        &(data.len() as u64).to_le_bytes(),
        MAGIC,
    ] {
        file.write_all(bytes)
            .map_err(|e| Diagnostic::io(target, e))?;
    }
    file.sync_all().map_err(|e| Diagnostic::io(target, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deploy_payloads_round_trip_and_reject_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let builder = temp.path().join("YMB.exe");
        let target = temp.path().join("Deploy.exe");
        paths::write_atomic(&builder, b"MZ builder fixture").unwrap();
        assert!(read(&builder).unwrap().is_none());
        let installer = Installer::from_config(
            "Example",
            &config::load::<ModConfig>(&{
                let path = temp.path().join("ymb.mod.yaml");
                paths::write_atomic(&path, "version: 2\nid: example\nname: Example\n").unwrap();
                path
            })
            .unwrap()
            .0,
        )
        .unwrap();
        write(&builder, &target, &installer).unwrap();
        assert_eq!(read(&target).unwrap().unwrap().project.id, "example");
        assert!(write(&target, &temp.path().join("nested.exe"), &installer).is_err());
        let mut bytes = fs::read(&target).unwrap();
        bytes[20] ^= 1;
        paths::write_atomic(&target, bytes).unwrap();
        assert!(read(&target).is_err());
    }
}
