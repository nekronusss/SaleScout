import nodemailer from "nodemailer";
import type { Config } from "./config.js";

export type SendMail = (
  email: string,
  purpose: "verify" | "reset",
  token: string,
) => Promise<void>;

export function createMailer(config: Config): SendMail {
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
    requireTLS: config.production && !config.smtp.secure,
    connectionTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async (email, purpose, token) => {
    const link = `${config.origin}/#${purpose}=${token}`;
    await transporter.sendMail({
      from: config.smtp.from,
      to: email,
      subject:
        purpose === "verify"
          ? "Подтвердите почту — SaleScout"
          : "Восстановление пароля — SaleScout",
      text:
        purpose === "verify"
          ? `Подтвердите адрес электронной почты для SaleScout:\n${link}\n\nСсылка действует 24 часа. Если вы не создавали аккаунт, проигнорируйте письмо.`
          : `Чтобы изменить пароль в SaleScout, откройте ссылку:\n${link}\n\nСсылка действует 30 минут и может быть использована один раз. Если вы не запрашивали восстановление, ничего делать не нужно.`,
    });
  };
}
