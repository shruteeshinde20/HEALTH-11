"""Sending e-mail over SMTP (Python's standard library, no extra package).

Used for "Forgot password?" codes. The server, port, security, account and
sender come from the settings (SMTP_* in .env); the password is never logged.
With SMTP_SECURITY=starttls or ssl the certificate of the mail server is
checked, so codes travel encrypted.
"""

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from app.config import get_settings

logger = logging.getLogger(__name__)

SENDER_NAME = "HEALTH-11"
LOGIN_REFUSED = ("The mail server refused the SMTP_USERNAME / SMTP_PASSWORD at login. For Gmail, "
                 "SMTP_PASSWORD must be a 16-letter app password (2-step verification on), not the "
                 "account password; after several failed logins Gmail may refuse for a while")


class MailError(Exception):
    """The e-mail could not be sent (the message never contains secrets)."""


def build_message(to_address: str, subject: str, text: str) -> EmailMessage:
    settings = get_settings()
    message = EmailMessage()
    message["From"] = formataddr((SENDER_NAME, settings.smtp_from or ""))
    message["To"] = to_address
    message["Subject"] = subject
    domain = (settings.smtp_from or "health11.local").rpartition("@")[2] or "health11.local"
    message["Message-ID"] = make_msgid(domain=domain)
    message.set_content(text)
    return message


def send_email(to_address: str, subject: str, text: str) -> None:
    settings = get_settings()
    if not settings.email_configured:
        raise MailError("E-mail is not set up (SMTP_HOST and SMTP_FROM)")
    message = build_message(to_address, subject, text)
    timeout = settings.smtp_timeout_seconds
    password = settings.smtp_password.get_secret_value() if settings.smtp_password else ""
    try:
        if settings.smtp_security == "ssl":
            server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=timeout,
                                      context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=timeout)
        with server:
            server.ehlo()
            if settings.smtp_security == "starttls":
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
            if settings.smtp_username and password:
                try:
                    server.login(settings.smtp_username, password)
                except smtplib.SMTPServerDisconnected:
                    # Gmail sometimes hangs up instead of answering "wrong password".
                    raise MailError(LOGIN_REFUSED) from None
            server.send_message(message)
    except smtplib.SMTPAuthenticationError:
        raise MailError(LOGIN_REFUSED) from None
    except MailError:
        raise
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        raise MailError(f"The mail server could not be reached or refused the message "
                        f"({type(exc).__name__})") from None
