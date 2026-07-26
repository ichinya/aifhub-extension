use std::env;
use std::io::{self, Read};
use std::path::PathBuf;

use sqz_engine::{CacheResult, Preset, SqzEngine};

fn classify_fresh_outcome(input: &str, output: &str) -> &'static str {
    if output == input {
        "full"
    } else {
        "compressed"
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("[sqz-isolated-adapter] {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let flag = args.next().ok_or("expected --store <path>")?;
    if flag != "--store" {
        return Err(format!("unexpected argument {flag}; expected --store").into());
    }
    let store_path = PathBuf::from(args.next().ok_or("missing store path")?);
    if args.next().is_some() {
        return Err("unexpected trailing arguments".into());
    }

    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;

    let engine = SqzEngine::with_preset_and_store(Preset::default(), &store_path)?;
    match engine.compress_with_cache(&input)? {
        CacheResult::Dedup {
            inline_ref,
            token_cost,
        } => {
            print!("{inline_ref}");
            eprintln!("[sqz-adapter] outcome=reference tokenCost={token_cost}");
        }
        CacheResult::Delta {
            delta_text,
            token_cost,
            similarity,
        } => {
            print!("{delta_text}");
            eprintln!(
                "[sqz-adapter] outcome=delta tokenCost={token_cost} similarity={similarity:.6}"
            );
        }
        CacheResult::Fresh { output } => {
            let outcome = classify_fresh_outcome(&input, &output.data);
            print!("{}", output.data);
            eprintln!(
                "[sqz-adapter] outcome={outcome} originalTokens={} compressedTokens={}",
                output.tokens_original, output.tokens_compressed
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::classify_fresh_outcome;

    #[test]
    fn identical_fresh_output_is_full() {
        assert_eq!(classify_fresh_outcome("unchanged", "unchanged"), "full");
    }

    #[test]
    fn transformed_fresh_output_is_compressed() {
        assert_eq!(classify_fresh_outcome("original", "short"), "compressed");
    }
}
