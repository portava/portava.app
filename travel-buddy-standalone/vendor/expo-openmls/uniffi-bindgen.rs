// Entry point for `cargo run --bin uniffi-bindgen`.
//
// This did not exist. Without it there is no way to generate the Swift/Kotlin
// bindings the native modules call, which is why nothing generated them.
fn main() {
    uniffi::uniffi_bindgen_main()
}
