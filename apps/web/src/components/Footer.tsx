import { HeartIcon } from '@phosphor-icons/react';
import { Clock } from '@repo/ui/components/clock';
import { Link } from '@tanstack/react-router';
import { useLocation } from '@tanstack/react-router';
import { useMemo } from 'react';

import { buildInfo } from '~/lib/buildInfo';

export function Footer() {
    const searchStr = useLocation({
        select: (location) => location.searchStr
    });

    const mountLocation = useMemo(() => {
        const params = new URLSearchParams(searchStr);
        return params.get('l');
    }, [searchStr]);

    if (mountLocation === 'gallery' || mountLocation === 'wall') return null;

    return (
        <footer className="absolute bottom-0 left-0 flex w-full items-center justify-between gap-2 p-4 text-sm text-accent">
            <span title="By Florian Guitton" className="grow">
                © 2026 Data Science Imperial{' · '}Built with{' '}
                <a
                    className="underline"
                    href="mailto:f.guitton@imperial.ac.uk"
                    aria-label="Email Florian Guitton"
                >
                    <HeartIcon weight="bold" className="mb-0.5 inline align-middle" />
                </a>{' '}
                at DSI
                {' · '}All rights reserved
                {' · '}Build <code>{buildInfo.commitSha}</code>
                {' · '}
                <Link className="underline" to="/legal/privacy">
                    Privacy notice
                </Link>
                {' · '}
                <Link className="underline" to="/legal/notices">
                    Third-party notices
                </Link>
            </span>
            <Clock />
        </footer>
    );
}
