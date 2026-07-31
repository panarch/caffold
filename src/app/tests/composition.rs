use super::super::*;

#[test]
fn application_router_merges_the_owned_state_routers() {
    let root = tempfile::tempdir().unwrap();
    let _router = router(RootedFs::new(root.path()).unwrap()).expect("owned state routers merge");
}
