export default function resolve() {
  return async (domain, options) => {
    return [{ address: domain, port: options?.srv ? 5222 : 5222 }];
  };
}
