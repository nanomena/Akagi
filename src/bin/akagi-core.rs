//! Akagi's core without a window, for a desktop shell to run. See `akagi::headless`.

fn main() {
    if let Err(e) = akagi::headless::run() {
        eprintln!("akagi-core: {e:#}");
        std::process::exit(1);
    }
}
