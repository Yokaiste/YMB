use super::*;

pub fn run(generators: &[GeneratorEntry], tests: &[TestEntry]) {
    let mut client = Client {
        reader: BufReader::new(std::io::stdin()),
        writer: BufWriter::new(std::io::stdout()),
        next_id: 1,
    };
    let result = (|| -> Result<()> {
        let HostMessage::Hello { protocol, .. } = read_frame(&mut client.reader)? else {
            return Err(protocol_error(crate::messages::text(
                "runtime.run.expected_a_host_handshake",
            )));
        };
        check_protocol(protocol)?;
        write_frame(
            &mut client.writer,
            &PluginMessage::Ready {
                protocol: core::metadata::PLUGIN_VERSION,
                requires: format!("^{}", core::metadata::VERSION),
            },
        )?;
        let HostMessage::Run {
            entry,
            phase,
            test_id,
            context,
        } = read_frame(&mut client.reader)?
        else {
            return Err(protocol_error(crate::messages::text(
                "runtime.run.expected_an_execution_request",
            )));
        };
        let variables = context.variables.clone();
        let mut context = Context {
            info: *context,
            variables,
            client,
            fixtures: HashMap::new(),
        };
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<PluginMessage> {
                if phase == "generate" {
                    let generator = generators
                        .iter()
                        .find(|generator| generator.name == entry)
                        .ok_or_else(|| {
                            failure(
                                crate::messages::format(
                                    "runtime.run.unknown_generator_entry_entry",
                                    &[("ENTRY", entry.to_string())],
                                ),
                                crate::messages::text(
                                    "runtime.run.register_the_entry_in_the_generator_executable",
                                ),
                            )
                        })?;
                    let outputs = (generator.generate)(&mut context)?;
                    if outputs.len() > MAX_OUTPUTS {
                        return Err(protocol_error(crate::messages::text(
                            "runtime.run.generator_returned_too_many_outputs",
                        )));
                    }
                    Ok(PluginMessage::Complete {
                        outputs,
                        tests: Vec::new(),
                    })
                } else {
                    let name = test_id.ok_or_else(|| {
                        protocol_error(crate::messages::text(
                            "runtime.run.test_execution_has_no_test_id",
                        ))
                    })?;
                    let test = tests.iter().find(|test| test.name == name).ok_or_else(|| {
                        failure(
                            crate::messages::format(
                                "runtime.run.unknown_test_entry_name",
                                &[("NAME", name.to_string())],
                            ),
                            crate::messages::text(
                                "runtime.run.register_the_companion_test_in_the_generator",
                            ),
                        )
                    })?;
                    Ok(PluginMessage::Complete {
                        outputs: Vec::new(),
                        tests: (test.run)(&mut context)?,
                    })
                }
            }));
        let result = match result {
            Ok(result) => result,
            Err(_) => Err(failure(
                crate::messages::text("runtime.run.generator_panicked"),
                crate::messages::text("runtime.run.read_stderr_and_fix_the_failed_generator"),
            )),
        };
        let failed = result.is_err();
        let reply = match result {
            Ok(reply) => reply,
            Err(error) => PluginMessage::Failed { error: *error },
        };
        write_frame(&mut context.client.writer, &reply)?;
        if failed {
            std::process::exit(1);
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
