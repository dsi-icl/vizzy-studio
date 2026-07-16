import { Body, Container, Head, Html, Preview, Section, Text } from 'react-email';

interface OtpEmailProps {
    otp: string;
}

export const OtpEmail = ({ otp }: OtpEmailProps) => (
    <Html>
        <Head />
        <Preview>Your one-time password</Preview>
        <Body style={main}>
            <Container style={container}>
                <Text style={h1}>Login to Vizzy Studio</Text>
                <Text style={text}>Use the following code to log in to your account.</Text>
                <Section style={codeBox}>
                    <Text style={code}>{otp}</Text>
                </Section>
                <Text style={text}>
                    If you didn’t request this, you can safely ignore this email.
                </Text>
            </Container>
        </Body>
    </Html>
);

export default OtpEmail;

const main = {
    backgroundColor: '#f6f9fc',
    padding: '10px 0'
};

const container = {
    backgroundColor: '#ffffff',
    border: '1px solid #f0f0f0',
    padding: '45px'
};

const h1 = {
    color: '#333',
    fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
    fontSize: '24px',
    fontWeight: 'bold',
    margin: '40px 0',
    padding: '0'
};

const text = {
    color: '#333',
    fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
    fontSize: '14px',
    margin: '24px 0'
};

const codeBox = {
    background: '#f6f9fc',
    border: '1px solid #f0f0f0',
    padding: '20px',
    margin: '0 auto',
    width: '200px',
    textAlign: 'center' as const
};

const code = {
    color: '#333',
    fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
    fontSize: '24px',
    fontWeight: 'bold',
    letterSpacing: '0.5em',
    margin: '0',
    padding: '0'
};
