import { FC } from 'react';

interface CardProps {
    width: number;
    height: number;
    params?: Record<string, string | number | null>;
}

export const OGCard: FC<CardProps> = ({ width, height, params }) => {
    const title = `Vizzy Studio ${params?.o === 't' ? '𝕏' : ''}`;
    return (
        <div
            style={{
                display: 'flex',
                height,
                width,
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
                backgroundImage:
                    'linear-gradient(to bottom, rgba(217, 165, 148, 0.2), rgba(78, 129, 240, 0.2), rgba(130, 230, 226, 0.2))',
                fontSize: width / 12,
                letterSpacing: -width / 220,
                fontWeight: 700,
                whiteSpace: 'nowrap'
            }}
        >
            <div
                style={{
                    padding: '5px 40px',
                    width: 'auto',
                    textAlign: 'center',
                    fontSize: height / 8,
                    color: 'black'
                }}
            >
                {title}
            </div>
        </div>
    );
};

export default OGCard;
