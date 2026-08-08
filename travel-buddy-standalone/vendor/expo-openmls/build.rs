fn main() {
    // UDL lives in src/ — uniffi's bindgen CLI requires it to be inside the
    // crate's src directory, and build-time generation is happy there too.
    uniffi::generate_scaffolding("./src/openmls.udl").unwrap();
}
